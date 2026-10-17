import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  BrowserUseError,
  type ConnectedTab,
  type DaemonStatus,
  type DownloadInfo,
  daemonStatusSchema,
  downloadInfoSchema,
  type IpcClientMessage,
  type JsonObject,
  type JsonValue,
  PROTOCOL_VERSION,
  parseIpcServerMessage,
  serializeIpcMessage,
} from "@browser-use/protocol";
import { z } from "zod";
import type { Paths } from "../config";
import {
  canConnect,
  type EnsureDaemonDeps,
  ensureDaemon,
  restartDaemon,
  type SpawnDaemon,
} from "./ensure-daemon";

const pairingCodeSchema = z.object({ code: z.string(), expiresInSeconds: z.number() });

type Listener = (method: string, params: JsonObject) => void;
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
type Request = Distribute<Extract<IpcClientMessage, { id: number }>>;

export interface ConnectOptions {
  paths: Paths;
  clientVersion: string;
  entryScript: string;
  autostart?: boolean;
  spawnDaemon?: SpawnDaemon;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function notRunning(): BrowserUseError {
  return new BrowserUseError("BRIDGE_DISCONNECTED", "The Browser Use daemon is not running", {
    hint: "It starts automatically when an MCP client connects. Run `browseruse-mcp doctor` for details.",
  });
}

function ensureDeps(options: ConnectOptions): EnsureDaemonDeps {
  return {
    clientVersion: options.clientVersion,
    ...(options.spawnDaemon ? { spawnDaemon: options.spawnDaemon } : {}),
  };
}

function connectSocket(endpoint: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const connection = net.createConnection(endpoint);
    connection.once("connect", () => {
      resolve(connection);
    });
    connection.once("error", () => {
      reject(notRunning());
    });
  });
}

export class DaemonClient {
  #socket: net.Socket;
  readonly #options: ConnectOptions;
  #buffer = "";
  #nextId = 0;
  #tabs: ConnectedTab[] = [];
  #daemonVersion = "";
  readonly #pending = new Map<
    number,
    { resolve(value: JsonValue): void; reject(error: Error): void }
  >();
  readonly #listeners = new Map<string, { tabId: number; listener: Listener }>();
  readonly #removal = new Map<string, (tabId: number) => void>();
  readonly #tabListeners = new Set<(tabs: ConnectedTab[]) => void>();
  #helloAck: { resolve(daemonVersion: string): void; reject(error: Error): void } | undefined;
  #reopening: Promise<void> | undefined;

  private constructor(socket: net.Socket, options: ConnectOptions) {
    this.#socket = socket;
    this.#options = options;
    this.#adopt(socket);
  }

  static async connect(options: ConnectOptions): Promise<DaemonClient> {
    const { paths, entryScript, autostart = true } = options;
    if (autostart) await ensureDaemon(paths, entryScript, ensureDeps(options));
    else if (!(await canConnect(paths.ipcEndpoint))) throw notRunning();
    let client = await DaemonClient.#open(options);
    if (client.#needsRestart()) {
      // Older daemon than this client: let it drain and exit, then start the matching one.
      await restartDaemon(
        paths,
        entryScript,
        () => client.#shutdownForRestart(),
        ensureDeps(options),
      );
      client = await DaemonClient.#open(options);
    }
    return client;
  }

  static async #open(options: ConnectOptions): Promise<DaemonClient> {
    const socket = await connectSocket(options.paths.ipcEndpoint);
    const client = new DaemonClient(socket, options);
    await client.#greet();
    return client;
  }

  async #greet(): Promise<void> {
    const ack = this.#awaitHello();
    this.#write({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: this.#options.clientVersion,
    });
    this.#daemonVersion = await ack;
  }

  #needsRestart(): boolean {
    const { autostart = true, clientVersion } = this.#options;
    return autostart && compareVersions(this.#daemonVersion, clientVersion) < 0;
  }

  /** Asks the connected daemon to drain and exit, on this socket only (never reconnects). */
  async #shutdownForRestart(): Promise<boolean> {
    try {
      await this.#call({ type: "shutdown" });
      return true;
    } catch {
      return false;
    } finally {
      this.#socket.destroy();
    }
  }

  #adopt(socket: net.Socket): void {
    socket.setEncoding("utf8");
    this.#buffer = "";
    socket.on("data", (data: string) => {
      if (socket === this.#socket) this.#onData(data);
    });
    socket.on("close", () => {
      if (socket === this.#socket) {
        this.#helloAck?.reject(
          new BrowserUseError("BRIDGE_DISCONNECTED", "The Browser Use daemon disconnected"),
        );
        this.#helloAck = undefined;
        this.#failAll(
          new BrowserUseError("BRIDGE_DISCONNECTED", "The Browser Use daemon disconnected"),
        );
      }
    });
    socket.on("error", () => socket.destroy());
  }

  #awaitHello(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.#helloAck = { resolve, reject };
    });
  }

  listTabs(): ConnectedTab[] {
    return this.#tabs;
  }

  async status(): Promise<DaemonStatus> {
    return daemonStatusSchema.parse(await this.#request({ type: "status" }));
  }

  async openTab(url: string): Promise<number> {
    const value = await this.#request({ type: "openTab", url });
    if (typeof value !== "number")
      throw new BrowserUseError("INTERNAL", "Daemon returned an invalid tab id");
    return value;
  }

  async closeTab(tabId: number): Promise<void> {
    await this.#request({ type: "closeTab", tabId });
  }

  async isFileAccessAllowed(): Promise<boolean> {
    return (await this.#request({ type: "fileAccess" })) === true;
  }

  sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs = 10_000,
  ): Promise<JsonValue> {
    return this.#request({ type: "sendCommand", tabId, method, params, timeoutMs });
  }

  async listDownloads(): Promise<DownloadInfo[]> {
    return z.array(downloadInfoSchema).parse(await this.#request({ type: "listDownloads" }));
  }

  async createPairingCode(): Promise<{ code: string; expiresInSeconds: number }> {
    return pairingCodeSchema.parse(await this.#request({ type: "createPairingCode" }));
  }

  async resetToken(): Promise<void> {
    await this.#request({ type: "resetToken" });
  }

  async shutdown(): Promise<void> {
    await this.#request({ type: "shutdown" });
  }

  subscribe(tabId: number, listener: Listener): () => void {
    const subscriptionId = randomUUID();
    this.#listeners.set(subscriptionId, { tabId, listener });
    this.#write({ type: "subscribe", subscriptionId, tabId });
    return () => {
      this.#listeners.delete(subscriptionId);
      this.#write({ type: "unsubscribe", subscriptionId });
    };
  }

  onTabRemoved(listener: (tabId: number) => void): () => void {
    const subscriptionId = randomUUID();
    this.#removal.set(subscriptionId, listener);
    this.#write({ type: "subscribeRemoval", subscriptionId });
    return () => {
      this.#removal.delete(subscriptionId);
      this.#write({ type: "unsubscribe", subscriptionId });
    };
  }

  onTabsChanged(listener: (tabs: ConnectedTab[]) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  close(): void {
    this.#socket.destroy();
  }

  async #ensureOpen(): Promise<void> {
    if (!this.#socket.destroyed) return;
    this.#reopening ??= this.#reopen().finally(() => {
      this.#reopening = undefined;
    });
    await this.#reopening;
  }

  async #reopen(): Promise<void> {
    const { paths, entryScript, autostart = true } = this.#options;
    if (autostart) await ensureDaemon(paths, entryScript, ensureDeps(this.#options));
    await this.#attach();
    // The daemon we reached may be older than this client (another, older MCP process started
    // it in the gap). Replace it, exactly as connect() does, instead of silently staying on it.
    if (this.#needsRestart()) {
      await restartDaemon(
        paths,
        entryScript,
        () => this.#shutdownForRestart(),
        ensureDeps(this.#options),
      );
      await this.#attach();
    }
    for (const [subscriptionId, { tabId }] of this.#listeners) {
      this.#write({ type: "subscribe", subscriptionId, tabId });
    }
    for (const subscriptionId of this.#removal.keys()) {
      this.#write({ type: "subscribeRemoval", subscriptionId });
    }
  }

  async #attach(): Promise<void> {
    const socket = await connectSocket(this.#options.paths.ipcEndpoint);
    this.#socket = socket;
    this.#adopt(socket);
    await this.#greet();
  }

  async #request(message: Request): Promise<JsonValue> {
    await this.#ensureOpen();
    return this.#call(message);
  }

  /** Sends on the current socket without reconnecting. */
  #call(message: Request): Promise<JsonValue> {
    if (this.#socket.destroyed) {
      return Promise.reject(
        new BrowserUseError("BRIDGE_DISCONNECTED", "The Browser Use daemon disconnected"),
      );
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ ...message, id });
    });
  }

  #write(message: IpcClientMessage): void {
    if (!this.#socket.destroyed) this.#socket.write(serializeIpcMessage(message));
  }

  #onData(data: string): void {
    this.#buffer += data;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      let message: ReturnType<typeof parseIpcServerMessage>;
      try {
        message = parseIpcServerMessage(line);
      } catch {
        continue;
      }
      switch (message.type) {
        case "helloAck":
          this.#helloAck?.resolve(message.daemonVersion);
          this.#helloAck = undefined;
          break;
        case "tabsChanged":
          this.#tabs = message.tabs;
          for (const listener of this.#tabListeners) listener(message.tabs);
          break;
        case "event":
          this.#listeners.get(message.subscriptionId)?.listener(message.method, message.params);
          break;
        case "tabRemoved":
          this.#removal.get(message.subscriptionId)?.(message.tabId);
          break;
        case "downloadsChanged":
          break;
        case "result": {
          const pending = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          pending?.resolve(message.value);
          break;
        }
        case "failure": {
          const pending = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          const { code, message: text, hint, details } = message.error;
          pending?.reject(
            new BrowserUseError(code, text, {
              ...(hint === undefined ? {} : { hint }),
              ...(details === undefined ? {} : { details }),
            }),
          );
          break;
        }
      }
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
