import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { BrowserUseError, MAX_WIRE_MESSAGE_BYTES } from "@browser-use/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { ExtensionPeer, type PeerAuth, type PeerEvents } from "./extension-peer";

const LOOPBACK_HOST = "127.0.0.1";

export interface BridgeServerOptions {
  port: number;
  extensionId: string;
  auth: PeerAuth;
  daemonVersion: string;
}

export class BridgeServer extends EventEmitter {
  readonly #options: BridgeServerOptions;
  #server: WebSocketServer | undefined;
  #peer: ExtensionPeer | undefined;
  readonly #connections = new Set<ExtensionPeer>();

  constructor(options: BridgeServerOptions) {
    super();
    this.#options = options;
  }

  get port(): number {
    return this.#options.port;
  }

  get peer(): ExtensionPeer | undefined {
    return this.#peer?.isReady ? this.#peer : undefined;
  }

  requirePeer(): ExtensionPeer {
    const peer = this.peer;
    if (!peer) {
      throw new BrowserUseError(
        "BRIDGE_DISCONNECTED",
        "The Browser Use extension is not connected",
        {
          hint: "Run `browseruse-mcp doctor`. Make sure the extension is installed, paired, and its popup shows Connected.",
        },
      );
    }
    return peer;
  }

  disconnectPeer(): void {
    this.#peer?.close();
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const { port, extensionId } = this.#options;
    const server = new WebSocketServer({
      host: LOOPBACK_HOST,
      port,
      maxPayload: MAX_WIRE_MESSAGE_BYTES,
      verifyClient: (info: { origin: string; req: IncomingMessage }) =>
        info.origin === `chrome-extension://${extensionId}` &&
        info.req.headers.host === `${LOOPBACK_HOST}:${port}`,
    });
    server.on("connection", (socket) => {
      this.#onConnection(socket);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new BrowserUseError("INTERNAL", `Port ${port} is already in use`, {
          hint: "Stop whatever is using it, or set BROWSER_USE_PORT and set the same port in the extension (chrome.storage.local key 'port').",
          cause: error,
        });
      }
      throw error;
    }
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const peer of this.#connections) peer.close();
    this.#connections.clear();
    this.#peer = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #onConnection(socket: WebSocket): void {
    const events: PeerEvents = {
      onReady: (peer) => {
        const previous = this.#peer;
        this.#peer = peer;
        if (previous && previous !== peer) previous.close();
        this.emit("ready", peer);
      },
      onClose: (peer) => {
        this.#connections.delete(peer);
        if (this.#peer === peer) {
          this.#peer = undefined;
          this.emit("disconnected");
        }
      },
      onTabsChanged: () => this.emit("tabsChanged"),
      onTabRemoved: (tabId) => this.emit("tabRemoved", tabId),
      onTabEvent: (tabId, method, params) => this.emit("tabEvent", tabId, method, params),
      onDownload: (download) => this.emit("download", download),
    };
    const peer = new ExtensionPeer(socket, this.#options.auth, events, this.#options.daemonVersion);
    this.#connections.add(peer);
  }
}
