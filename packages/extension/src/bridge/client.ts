import "../zod-jitless";
import {
  BrowserUseError,
  MAX_WIRE_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseWireMessage,
  serializeWireMessage,
  type WireMessage,
} from "@browser-use/protocol";
import type { Settings } from "./settings";

export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * `off`: paired, but no connection is wanted (no connected tab, "Let the agent open tabs" off).
 * `inUse`: the daemon refused this browser because another one holds its single peer slot.
 */
export type BridgeState =
  "idle" | "off" | "unpaired" | "connecting" | "ready" | "backoff" | "inUse" | "error";

/** States after which `waitForReady` stops waiting: the outcome of a connection attempt. */
const SETTLED: ReadonlySet<BridgeState> = new Set<BridgeState>([
  "off",
  "unpaired",
  "ready",
  "backoff",
  "inUse",
  "error",
]);

export interface BridgeHandlers {
  onMessage(message: WireMessage): void;
  onState(state: BridgeState, detail?: string): void;
}

export interface BridgeClientDeps {
  settings: Settings;
  createSocket(url: string): SocketLike;
  extensionVersion: string;
}

const OPEN = 1;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const VERSION_RETRY_MS = 30_000;
/** Another browser holds the daemon: retry slowly so two browsers never flap. */
export const IN_USE_RETRY_MS = 30_000;
const CODE_PATTERN = /^[A-Z2-9]{8}$/;

export class BridgeClient {
  #state: BridgeState = "idle";
  #socket: SocketLike | undefined;
  #running = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #terminal: "unpaired" | "version" | "inUse" | undefined;
  /** True while #connect awaits storage, so concurrent calls cannot open two sockets. */
  #opening = false;
  readonly #waiters = new Set<(state: BridgeState) => void>();
  /** Why the daemon refused the last handshake without revoking the pairing (throttle, timeout). */
  #retryDetail: string | undefined;

  constructor(
    private readonly deps: BridgeClientDeps,
    private readonly handlers: BridgeHandlers,
  ) {}

  get state(): BridgeState {
    return this.#state;
  }

  /** Whether a connection is wanted (between start and stop), whatever its current state. */
  get running(): boolean {
    return this.#running;
  }

  /** Reports `unpaired` or `off` from storage while no connection is wanted. */
  async init(): Promise<void> {
    if (this.#running) return;
    const token = await this.deps.settings.getToken();
    if (this.#startedMeanwhile()) return;
    if (token) {
      this.#terminal = undefined;
      this.#setState("off");
    } else {
      this.#terminal = "unpaired";
      this.#setState("unpaired", "Not paired");
    }
  }

  /**
   * Wants a connection. Idempotent while connected or connecting; from backoff or inUse it
   * retries now instead of waiting for the timer (an explicit Connect click).
   */
  async start(): Promise<void> {
    this.#running = true;
    this.#terminal = undefined;
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    await this.#connect();
  }

  /** No connection wanted: closes the socket and cancels heartbeat and reconnect timers. */
  stop(): void {
    this.#running = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "stopped");
    if (this.#terminal === "unpaired") {
      if (this.#state !== "unpaired") this.#setState("unpaired", "Not paired");
      return;
    }
    this.#terminal = undefined;
    this.#setState("off");
  }

  /**
   * Resolves with the outcome of the current connection attempt (`ready`, `backoff`, `inUse`,
   * ...), or with the state at `timeoutMs` if nothing settles by then.
   */
  waitForReady(timeoutMs: number): Promise<BridgeState> {
    if (SETTLED.has(this.#state)) return Promise.resolve(this.#state);
    return new Promise((resolve) => {
      const done = (state: BridgeState): void => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve(state);
      };
      const timer = setTimeout(() => {
        done(this.#state);
      }, timeoutMs);
      this.#waiters.add(done);
    });
  }

  send(message: WireMessage): void {
    const socket = this.#socket;
    if (this.#state !== "ready" || socket?.readyState !== OPEN) {
      throw new BrowserUseError("BRIDGE_DISCONNECTED", "Bridge unavailable", {
        hint: 'Connect a tab from the Browser Use popup (or turn on "Let the agent open tabs") and make sure an MCP client is running.',
      });
    }
    const text = serializeWireMessage(message);
    if (new TextEncoder().encode(text).byteLength > MAX_WIRE_MESSAGE_BYTES) {
      throw new BrowserUseError("LIMIT_EXCEEDED", "Bridge message exceeds the 2 MiB limit");
    }
    socket.send(text);
  }

  async pair(input: string): Promise<void> {
    const code = input.replace(/[-\s]/g, "").toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      throw new BrowserUseError(
        "INVALID_ARGUMENT",
        "Enter the 8-character code printed by `browseruse-mcp pair`",
      );
    }
    const port = await this.deps.settings.getPort();
    const token = await new Promise<string>((resolve, reject) => {
      const socket = this.deps.createSocket(`ws://127.0.0.1:${port}`);
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close(1000, "pairing done");
        action();
      };
      const timer = setTimeout(() => {
        finish(() => {
          reject(
            new BrowserUseError(
              "TIMEOUT",
              "The local server did not answer; is an MCP client running?",
            ),
          );
        });
      }, PAIR_TIMEOUT_MS);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "pair", version: PROTOCOL_VERSION, code }));
      };
      socket.onmessage = (event) => {
        try {
          const message = parseWireMessage(String(event.data));
          if (message.type === "paired")
            finish(() => {
              resolve(message.token);
            });
          else if (message.type === "error") {
            finish(() => {
              reject(new BrowserUseError(message.error.code, message.error.message));
            });
          }
        } catch (error) {
          finish(() => {
            reject(error instanceof Error ? error : new BrowserUseError("INTERNAL", String(error)));
          });
        }
      };
      socket.onerror = () => {
        finish(() => {
          reject(
            new BrowserUseError(
              "BRIDGE_DISCONNECTED",
              "Could not reach the local server on port " + String(port),
            ),
          );
        });
      };
      socket.onclose = () => {
        finish(() => {
          reject(
            new BrowserUseError("BRIDGE_DISCONNECTED", "The local server closed the connection"),
          );
        });
      };
    });
    await this.deps.settings.setToken(token);
    // The pairing socket is already closed. Reconnect with the new token only if a connection
    // is wanted; otherwise stay off (the controller decides, spec section 10).
    this.#terminal = undefined;
    this.#attempt = 0;
    this.#clearTimers();
    const previous = this.#socket;
    this.#socket = undefined;
    previous?.close(1000, "re-pairing");
    if (this.#running) await this.#connect();
    else this.#setState("off");
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#socket || this.#opening) return;
    this.#opening = true;
    let token: string | undefined;
    let port: number;
    let peerId: string;
    try {
      token = await this.deps.settings.getToken();
      port = await this.deps.settings.getPort();
      peerId = await this.deps.settings.getPeerId();
    } finally {
      this.#opening = false;
    }
    // start/stop may have run while storage was read.
    if (!this.#stillWantsSocket()) return;
    if (!token) {
      this.#terminal = "unpaired";
      this.#setState("unpaired", "Not paired");
      return;
    }
    // Retrying after BRIDGE_IN_USE keeps showing inUse until it either gets in or is refused
    // again, so the popup does not flicker every 30 s.
    if (this.#state !== "inUse") this.#setState("connecting");
    const socket = this.deps.createSocket(`ws://127.0.0.1:${port}`);
    this.#socket = socket;
    socket.onopen = () => {
      socket.send(
        serializeWireMessage({
          type: "hello",
          version: PROTOCOL_VERSION,
          peerId,
          token,
          extensionVersion: this.deps.extensionVersion,
        }),
      );
    };
    socket.onmessage = (event) => void this.#onMessage(socket, event.data);
    socket.onclose = () => {
      this.#onClose(socket);
    };
    socket.onerror = () => undefined;
  }

  async #onMessage(socket: SocketLike, data: unknown): Promise<void> {
    let message: WireMessage;
    try {
      message = parseWireMessage(String(data));
    } catch {
      socket.close(1002, "invalid message");
      return;
    }
    switch (message.type) {
      case "helloAck":
        this.#attempt = 0;
        this.#setState("ready");
        this.#startHeartbeat();
        return;
      case "pong":
        clearTimeout(this.#pongTimer);
        return;
      case "error":
        if (message.error.code === "NOT_PAIRED") {
          this.#terminal = "unpaired";
          await this.deps.settings.clearToken();
          this.#setState("unpaired", message.error.message);
          return;
        }
        // Only NOT_PAIRED (a genuine token mismatch) erases the token. A throttled or timed-out
        // handshake keeps it and retries with backoff when the daemon closes the socket.
        if (
          this.#state !== "ready" &&
          (message.error.code === "LIMIT_EXCEEDED" || message.error.code === "TIMEOUT")
        ) {
          this.#retryDetail = message.error.message;
          return;
        }
        // Another browser holds the daemon. The token is fine: keep it, report inUse and retry
        // slowly when the daemon closes the socket.
        if (this.#state !== "ready" && message.error.code === "BRIDGE_IN_USE") {
          this.#terminal = "inUse";
          this.#setState("inUse", message.error.message);
          return;
        }
        if (message.error.code === "VERSION_MISMATCH") {
          this.#terminal = "version";
          this.#setState("error", message.error.hint ?? message.error.message);
          return;
        }
        this.handlers.onMessage(message);
        return;
      default:
        this.handlers.onMessage(message);
    }
  }

  #onClose(socket: SocketLike): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#clearTimers();
    if (!this.#running) return;
    if (this.#terminal === "unpaired") return;
    const delay =
      this.#terminal === "version"
        ? VERSION_RETRY_MS
        : this.#terminal === "inUse"
          ? IN_USE_RETRY_MS
          : Math.min(1_000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
    if (this.#terminal !== "inUse") this.#attempt += 1;
    const detail = this.#retryDetail;
    this.#retryDetail = undefined;
    if (this.#terminal === undefined) this.#setState("backoff", detail);
    this.#retryTimer = setTimeout(() => {
      this.#terminal = undefined;
      void this.#connect();
    }, delay);
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#pingTimer = setInterval(() => {
      try {
        this.send({ type: "ping", version: PROTOCOL_VERSION });
      } catch {
        return;
      }
      this.#pongTimer = setTimeout(
        () => this.#socket?.close(4000, "heartbeat timeout"),
        PONG_TIMEOUT_MS,
      );
    }, PING_INTERVAL_MS);
  }

  /** Re-reads mutable state after an await (a method call keeps TypeScript from narrowing). */
  #startedMeanwhile(): boolean {
    return this.#running;
  }

  #stillWantsSocket(): boolean {
    return this.#running && this.#socket === undefined;
  }

  #clearHeartbeat(): void {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = undefined;
    this.#pongTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #setState(state: BridgeState, detail?: string): void {
    this.#state = state;
    this.handlers.onState(state, detail);
    if (SETTLED.has(state)) for (const waiter of [...this.#waiters]) waiter(state);
  }
}
