import { chmod, unlink } from "node:fs/promises";
import net from "node:net";
import {
  BrowserUseError,
  type DaemonStatus,
  type IpcClientMessage,
  type IpcServerMessage,
  type JsonValue,
  jsonValueSchema,
  MAX_IPC_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseIpcClientMessage,
  serializeIpcMessage,
} from "@browser-use/protocol";
import { isPipe } from "../client/ensure-daemon";
import type { BrowserBackend } from "./backend";
import type { Logger } from "./log";
import type { PairingCodes } from "./token-store";

export interface DaemonDeps {
  backend: BrowserBackend;
  pairing: PairingCodes;
  daemonVersion: string;
  port: number;
  rotateToken(): Promise<void>;
  onShutdown(): void;
  /** Records dropped (malformed, oversize or pre-hello) IPC messages; never their content. */
  log?: Logger;
  /** Upper bound on how long `shutdown` waits for in-flight requests (default 30 s). */
  drainTimeoutMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

function toJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value ?? null)));
}

export class IpcServer {
  readonly #deps: DaemonDeps;
  readonly #clients = new Set<net.Socket>();
  #server: net.Server | undefined;
  #endpoint: string | undefined;
  #inFlight = 0;
  #draining = false;

  constructor(deps: DaemonDeps) {
    this.#deps = deps;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * IPC trust model: the IPC protocol is unauthenticated. Any process that can connect may mint
   * pairing codes and drive connected tabs, so access control is the filesystem: the socket lives
   * in the 0700 state directory (see `ensurePrivateHome`) and is itself chmod 0600, which limits
   * it to the daemon's own OS user. Processes running as that user are trusted (they could read
   * the token file anyway). On Windows the named pipe keeps its default DACL; spec section 4.3
   * records this as a known gap.
   */
  async listen(endpoint: string): Promise<void> {
    this.#endpoint = endpoint;
    const server = net.createServer((socket) => {
      this.#onConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    if (!isPipe(endpoint)) {
      try {
        await chmod(endpoint, 0o600);
      } catch (error) {
        await this.close();
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.destroy();
    this.#clients.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server)
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    if (server && this.#endpoint && !isPipe(this.#endpoint)) {
      await unlink(this.#endpoint).catch(() => undefined);
    }
  }

  async #drain(): Promise<void> {
    this.#draining = true;
    const deadline = Date.now() + (this.#deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.#inFlight > 0) {
      void this.#deps.log?.error(`shutdown: ${this.#inFlight} request(s) still running; exiting`);
    }
  }

  #status(): DaemonStatus {
    const { backend, daemonVersion, port } = this.#deps;
    return {
      daemonVersion,
      pid: process.pid,
      port,
      paired: true,
      extensionConnected: backend.isConnected(),
      tabs: backend.listTabs(),
      mode: "extension",
    };
  }

  #onConnection(socket: net.Socket): void {
    this.#clients.add(socket);
    socket.setEncoding("utf8");
    const subscriptions = new Map<string, () => void>();
    const offs: (() => void)[] = [];
    let buffer = "";
    let greeted = false;

    const write = (message: IpcServerMessage): void => {
      if (!socket.destroyed && !socket.writableEnded) {
        socket.write(serializeIpcMessage(message), (error) => {
          if (error) socket.destroy();
        });
      }
    };
    const fail = (id: number, error: unknown): void => {
      const payload =
        error instanceof BrowserUseError
          ? error.toPayload()
          : new BrowserUseError(
              "INTERNAL",
              error instanceof Error ? error.message : String(error),
            ).toPayload();
      write({ type: "failure", id, error: payload });
    };

    const dispatch = async (message: IpcClientMessage): Promise<void> => {
      const { backend } = this.#deps;
      switch (message.type) {
        case "hello":
          return;
        case "subscribe":
          subscriptions.set(
            message.subscriptionId,
            backend.subscribe(message.tabId, (method, params) => {
              write({ type: "event", subscriptionId: message.subscriptionId, method, params });
            }),
          );
          return;
        case "subscribeRemoval":
          subscriptions.set(
            message.subscriptionId,
            backend.onTabRemoved((tabId) => {
              write({ type: "tabRemoved", subscriptionId: message.subscriptionId, tabId });
            }),
          );
          return;
        case "unsubscribe":
          subscriptions.get(message.subscriptionId)?.();
          subscriptions.delete(message.subscriptionId);
          return;
        default:
          break;
      }
      // Spec 4.4: a shutdown (version restart or `stop`) is graceful. It stops accepting new
      // work, waits for in-flight requests (bounded), and only then answers and exits.
      const counted = message.type !== "shutdown" && message.type !== "status";
      if (counted) this.#inFlight += 1;
      try {
        if (this.#draining && counted) {
          throw new BrowserUseError("BRIDGE_DISCONNECTED", "The Browser Use daemon is restarting", {
            hint: "Retry the call; the MCP server reconnects to the new daemon automatically.",
          });
        }
        let value: unknown;
        switch (message.type) {
          case "status":
            value = this.#status();
            break;
          case "listTabs":
            value = backend.listTabs();
            break;
          case "listDownloads":
            value = backend.listDownloads();
            break;
          case "fileAccess":
            value = await backend.isFileAccessAllowed();
            break;
          case "openTab":
            value = await backend.openTab(message.url);
            break;
          case "closeTab":
            await backend.closeTab(message.tabId);
            value = true;
            break;
          case "sendCommand":
            value = await backend.sendCommand(
              message.tabId,
              message.method,
              message.params,
              message.timeoutMs,
            );
            break;
          case "createPairingCode":
            value = { code: this.#deps.pairing.create(), expiresInSeconds: 300 };
            break;
          case "resetToken":
            await this.#deps.rotateToken();
            value = true;
            break;
          case "shutdown":
            await this.#drain();
            value = true;
            break;
        }
        write({ type: "result", id: message.id, value: toJson(value) });
        if (message.type === "shutdown")
          setImmediate(() => {
            this.#deps.onShutdown();
          });
      } catch (error) {
        fail(message.id, error);
      } finally {
        if (counted) this.#inFlight -= 1;
      }
    };

    offs.push(
      this.#deps.backend.onTabsChanged((tabs) => {
        if (greeted) write({ type: "tabsChanged", tabs });
      }),
      this.#deps.backend.onDownloadsChanged((downloads) => {
        if (greeted) write({ type: "downloadsChanged", downloads });
      }),
    );

    const drop = (reason: string): void => {
      void this.#deps.log?.error(`ipc client dropped: ${reason}`);
      socket.destroy();
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_IPC_MESSAGE_BYTES) {
        drop("message exceeds the size limit");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: IpcClientMessage;
        try {
          message = parseIpcClientMessage(line);
        } catch {
          drop("malformed message");
          return;
        }
        if (!greeted) {
          if (message.type !== "hello") {
            drop(`${message.type} before hello`);
            return;
          }
          greeted = true;
          write({
            type: "helloAck",
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion: this.#deps.daemonVersion,
          });
          write({ type: "tabsChanged", tabs: this.#deps.backend.listTabs() });
          continue;
        }
        void dispatch(message);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      for (const off of offs) off();
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      this.#clients.delete(socket);
    });
  }
}
