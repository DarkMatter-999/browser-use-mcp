import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { BrowserUseError, MAX_WIRE_MESSAGE_BYTES } from "@browser-use/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_DISCONNECTED_HINT,
  ExtensionPeer,
  type PeerAuth,
  type PeerEvents,
} from "./extension-peer";
import type { Logger } from "./log";

const LOOPBACK_HOST = "127.0.0.1";
/**
 * The extension pings every 20 s and waits 10 s for the pong. A ready peer silent for longer has
 * missed its heartbeat window (half-open socket, frozen browser) and no longer holds the slot.
 */
const PEER_STALE_MS = 30_000;

export interface BridgeServerOptions {
  port: number;
  extensionId: string;
  auth: PeerAuth;
  daemonVersion: string;
  /** Override of the heartbeat window after which a silent ready peer may be replaced (tests). */
  peerStaleMs?: number;
  /** Records rejected upgrades, handshake denials and protocol errors (never tokens or codes). */
  log?: Logger;
}

/** Header values are attacker-controlled: bound them and escape control characters for the log. */
function printable(value: string | undefined): string {
  return value === undefined ? "(none)" : JSON.stringify(value.slice(0, 200));
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
        { hint: BRIDGE_DISCONNECTED_HINT },
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
      verifyClient: (info: { origin: string; req: IncomingMessage }) => {
        const originOk = info.origin === `chrome-extension://${extensionId}`;
        const hostOk = info.req.headers.host === `${LOOPBACK_HOST}:${port}`;
        if (!originOk || !hostOk) {
          const reasons = [
            ...(originOk ? [] : [`origin ${printable(info.origin)}`]),
            ...(hostOk ? [] : [`host ${printable(info.req.headers.host)}`]),
          ];
          void this.#options.log?.error(
            `bridge upgrade rejected from :${String(info.req.socket.remotePort)}: ${reasons.join(" ")}`,
          );
        }
        return originOk && hostOk;
      },
    });
    server.on("connection", (socket, request) => {
      this.#onConnection(socket, request.socket.remotePort);
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

  /**
   * Single peer slot, first come first served: a later hello is refused while a live peer holds
   * it. A peer that missed its heartbeat window is dropped so a dead browser cannot lock others
   * out until the 90 s idle timeout.
   */
  #admit(candidate: ExtensionPeer): boolean {
    const current = this.#peer;
    if (!current || current === candidate || !current.isReady) return true;
    if (current.silentForMs <= (this.#options.peerStaleMs ?? PEER_STALE_MS)) return false;
    void this.#options.log?.info(
      `bridge: dropping the previous peer (silent for ${String(current.silentForMs)} ms)`,
    );
    current.close();
    return true;
  }

  #onConnection(socket: WebSocket, remotePort?: number): void {
    const events: PeerEvents = {
      admit: (peer) => this.#admit(peer),
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
      onTabRegistered: (tabId, pendingDialog) => this.emit("tabRegistered", tabId, pendingDialog),
      onTabRemoved: (tabId) => this.emit("tabRemoved", tabId),
      onTabEvent: (tabId, method, params) => this.emit("tabEvent", tabId, method, params),
      onDownload: (download) => this.emit("download", download),
    };
    const { log } = this.#options;
    const peer = new ExtensionPeer(
      socket,
      this.#options.auth,
      events,
      this.#options.daemonVersion,
      {
        ...(log === undefined ? {} : { log }),
        label: `bridge peer :${String(remotePort)}`,
      },
    );
    this.#connections.add(peer);
  }
}
