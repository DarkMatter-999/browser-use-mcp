import { randomUUID } from "node:crypto";
import {
  BrowserUseError,
  type ConnectedTab,
  type ErrorCode,
  type JsonObject,
  type JsonValue,
  type PendingDialog,
  PROTOCOL_VERSION,
  parseWireMessage,
  serializeWireMessage,
  type WireMessage,
} from "@browser-use/protocol";
import type { Logger } from "./log";
import { PendingRequests } from "./pending-requests";

export interface PeerSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[] | string) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface PeerAuth {
  verifyToken(token: string): boolean;
  consumePairingCode(code: string): string | undefined;
  /** Throttles pairing-code guesses (40-bit codes). Never applied to `hello`: see #onHandshakeMessage. */
  limiter: { blocked(): boolean; record(): void };
}

const NO_LOG: Logger = {
  info: () => Promise.resolve(),
  error: () => Promise.resolve(),
};

type DownloadMessage = Extract<WireMessage, { type: "download" }>;
type RegisterTabMessage = Extract<WireMessage, { type: "registerTab" }>;

export interface PeerEvents {
  /**
   * Asked after the token checks out, before the peer becomes ready. Returning false refuses the
   * hello with BRIDGE_IN_USE (another browser holds the single peer slot). Not a pairing failure:
   * the token is valid and the limiter is untouched. Omitted means always admit.
   */
  admit?(peer: ExtensionPeer): boolean;
  onReady(peer: ExtensionPeer): void;
  onClose(peer: ExtensionPeer): void;
  onTabsChanged(): void;
  /**
   * A tab was (re-)registered. `pendingDialog` is the extension's view of an open dialog, which
   * the daemon may have missed while the bridge was down; undefined means none is open.
   */
  onTabRegistered?(tabId: number, pendingDialog: PendingDialog | undefined): void;
  onTabRemoved(tabId: number): void;
  onTabEvent(tabId: number, method: string, params: JsonObject): void;
  onDownload(download: DownloadMessage): void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 90_000;
const TAB_ACTION_TIMEOUT_MS = 30_000;

/** Shown wherever a daemon call needs the extension and no ready peer is connected. */
export const BRIDGE_DISCONNECTED_HINT =
  'Connect a tab from the Browser Use extension popup, or turn on "Let the agent open tabs" in the popup\'s Settings so the extension stays connected. If the popup says Not paired, run `browseruse-mcp pair`; `browseruse-mcp doctor` checks the rest.';

export const BRIDGE_IN_USE_MESSAGE =
  "Another browser is already connected to Browser Use. Close its connection or disconnect its tabs first.";

export class ExtensionPeer {
  readonly #socket: PeerSocket;
  readonly #pending = new PendingRequests();
  readonly #tabs = new Map<number, ConnectedTab>();
  #ready = false;
  #closed = false;
  #peerId: string | undefined;
  #lastSeen = Date.now();
  #handshakeTimer: ReturnType<typeof setTimeout>;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #log: Logger;
  readonly #label: string;

  /**
   * @param label identifies the connection in log lines (for example the remote port). It must
   *   never contain secrets: log lines carry reasons only, never tokens or pairing codes.
   */
  constructor(
    socket: PeerSocket,
    private readonly auth: PeerAuth,
    private readonly events: PeerEvents,
    private readonly daemonVersion: string,
    options: { log?: Logger; label?: string } = {},
  ) {
    this.#socket = socket;
    this.#log = options.log ?? NO_LOG;
    this.#label = options.label ?? "bridge peer";
    socket.on("message", (data) => {
      this.#onMessage(data);
    });
    socket.on("close", () => {
      this.#teardown("Extension bridge disconnected");
    });
    socket.on("error", () => {
      this.#teardown("Extension bridge socket errored");
    });
    this.#handshakeTimer = setTimeout(() => {
      this.#deny("TIMEOUT", "Handshake timed out; open the Browser Use popup and reconnect.");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  get isReady(): boolean {
    return this.#ready && !this.#closed && this.#socket.readyState === this.#socket.OPEN;
  }

  get peerId(): string | undefined {
    return this.#peerId;
  }

  /** Milliseconds since the extension last sent anything (it pings every 20 s while ready). */
  get silentForMs(): number {
    return Date.now() - this.#lastSeen;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  listTabs(): ConnectedTab[] {
    return [...this.#tabs.values()].sort((a, b) => a.tabId - b.tabId);
  }

  hasTab(tabId: number): boolean {
    return this.#tabs.has(tabId);
  }

  sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs: number,
  ): Promise<JsonValue> {
    this.#requireReady();
    if (!this.#tabs.has(tabId)) {
      throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`, {
        hint: "Call browser_tabs to see connected tabs, or connect the tab from the Browser Use popup.",
      });
    }
    const requestId = randomUUID();
    return this.#request(
      { type: "command", version: PROTOCOL_VERSION, requestId, tabId, method, params },
      requestId,
      timeoutMs,
      tabId,
    );
  }

  async openTab(url: string): Promise<number> {
    this.#requireReady();
    const requestId = randomUUID();
    const result = await this.#request(
      { type: "openTab", version: PROTOCOL_VERSION, requestId, url },
      requestId,
      TAB_ACTION_TIMEOUT_MS,
    );
    const tabId =
      typeof result === "object" && result !== null && !Array.isArray(result)
        ? result.tabId
        : undefined;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0) {
      throw new BrowserUseError("INTERNAL", "Open tab response did not include a valid tabId");
    }
    return tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    this.#requireReady();
    if (!this.#tabs.has(tabId)) {
      throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`);
    }
    const requestId = randomUUID();
    await this.#request(
      { type: "closeTab", version: PROTOCOL_VERSION, requestId, tabId },
      requestId,
      TAB_ACTION_TIMEOUT_MS,
    );
  }

  async isFileAccessAllowed(): Promise<boolean> {
    this.#requireReady();
    const requestId = randomUUID();
    const result = await this.#request(
      { type: "fileAccess", version: PROTOCOL_VERSION, requestId },
      requestId,
      5_000,
    );
    return (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result) &&
      result.allowed === true
    );
  }

  failPendingForTab(tabId: number, error: BrowserUseError): number {
    return this.#pending.rejectWhere(tabId, error);
  }

  close(): void {
    this.#teardown("Bridge closed");
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.close(1001, "closing");
  }

  #requireReady(): void {
    if (!this.isReady) {
      throw new BrowserUseError(
        "BRIDGE_DISCONNECTED",
        "The Browser Use extension is not connected",
        { hint: BRIDGE_DISCONNECTED_HINT },
      );
    }
  }

  #request(
    message: WireMessage,
    requestId: string,
    timeoutMs: number,
    tag?: number,
  ): Promise<JsonValue> {
    const promise = this.#pending.create(requestId, timeoutMs, tag);
    try {
      this.#send(message);
    } catch (cause) {
      this.#pending.reject(
        requestId,
        new BrowserUseError("BRIDGE_DISCONNECTED", "Failed to send bridge message", { cause }),
      );
    }
    return promise;
  }

  #send(message: WireMessage): void {
    this.#socket.send(serializeWireMessage(message));
  }

  #onMessage(data: Buffer | ArrayBuffer | Buffer[] | string): void {
    if (this.#closed) return;
    let message: WireMessage;
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString("utf8");
      message = parseWireMessage(text);
    } catch (error) {
      if (error instanceof BrowserUseError) {
        this.#trySend({ type: "error", version: PROTOCOL_VERSION, error: error.toPayload() });
      }
      // Only the error code is logged: the raw message could carry a token or pairing code.
      const code = error instanceof BrowserUseError ? error.code : "INTERNAL";
      this.#protocolError(`Invalid bridge message (${code})`);
      return;
    }
    this.#lastSeen = Date.now();
    if (this.#idleTimer) this.#armIdle();
    if (!this.#ready) {
      this.#onHandshakeMessage(message);
      return;
    }
    this.#onReadyMessage(message);
  }

  #onHandshakeMessage(message: WireMessage): void {
    if (message.type !== "hello" && message.type !== "pair") {
      this.#protocolError("Expected hello or pair before other bridge messages");
      return;
    }
    if (message.type === "pair") {
      // The limiter exists to slow brute force of the 40-bit pairing code, so it gates `pair`
      // only. A throttled pair is LIMIT_EXCEEDED (retry later), never NOT_PAIRED.
      if (this.auth.limiter.blocked()) {
        this.#deny(
          "LIMIT_EXCEEDED",
          "Too many failed pairing attempts. Wait a minute and try again.",
        );
        return;
      }
      const token = this.auth.consumePairingCode(message.code);
      if (token === undefined) {
        this.auth.limiter.record();
        this.#deny(
          "INVALID_ARGUMENT",
          "Invalid or expired pairing code. Run `browseruse-mcp pair` for a new one.",
        );
        return;
      }
      void this.#log.info(`${this.#label}: pairing code accepted`);
      this.#send({ type: "paired", version: PROTOCOL_VERSION, token });
      return;
    }
    // `hello` is never throttled: the 256-bit token cannot be brute forced and the comparison is
    // constant time, so a local process spamming bad hellos cannot lock the real extension out.
    // NOT_PAIRED is sent only for a genuine token mismatch; the extension erases its token on it.
    if (!this.auth.verifyToken(message.token)) {
      this.#deny(
        "NOT_PAIRED",
        "Not paired. Run `browseruse-mcp pair` and enter the code in the extension popup.",
      );
      return;
    }
    // A second browser with a valid token is refused rather than evicting the first (which made
    // two browsers flap). BRIDGE_IN_USE never touches the limiter or the stored token.
    if (this.events.admit?.(this) === false) {
      this.#deny("BRIDGE_IN_USE", BRIDGE_IN_USE_MESSAGE, "in use");
      return;
    }
    clearTimeout(this.#handshakeTimer);
    this.#ready = true;
    this.#peerId = message.peerId;
    this.#send({ type: "helloAck", version: PROTOCOL_VERSION, daemonVersion: this.daemonVersion });
    this.#armIdle();
    this.events.onReady(this);
  }

  #onReadyMessage(message: WireMessage): void {
    switch (message.type) {
      case "ping":
        this.#send({ type: "pong", version: PROTOCOL_VERSION });
        return;
      case "registerTab":
        this.#registerTab(message);
        return;
      case "unregisterTab":
        if (this.#tabs.delete(message.tabId)) {
          this.events.onTabRemoved(message.tabId);
          this.events.onTabsChanged();
        }
        return;
      case "response":
        this.#pending.resolve(message.requestId, message.result);
        return;
      case "error":
        if (message.requestId !== undefined) {
          const { code, message: text, hint, details } = message.error;
          this.#pending.reject(
            message.requestId,
            new BrowserUseError(code, text, {
              ...(hint === undefined ? {} : { hint }),
              ...(details === undefined ? {} : { details }),
            }),
          );
        }
        return;
      case "event":
        this.#onTabEvent(message.tabId, message.method, message.params);
        return;
      case "download":
        this.events.onDownload(message);
        return;
      default:
        this.#protocolError(`Unexpected ${message.type} message from the extension`);
    }
  }

  #registerTab(message: RegisterTabMessage): void {
    const { tabId, url, title, active, autoConnected, pendingDialog } = message;
    const previous = this.#tabs.get(tabId);
    this.#tabs.set(tabId, {
      tabId,
      url,
      title,
      ...(active === undefined ? {} : { active }),
      ...((autoConnected ?? previous?.autoConnected) === undefined
        ? {}
        : { autoConnected: autoConnected ?? previous?.autoConnected }),
    });
    // Dialog state is owned by the backend's DialogTracker; it is not stored on the tab here,
    // so a stale copy can never outlive Page.javascriptDialogClosed.
    this.events.onTabRegistered?.(tabId, pendingDialog);
    this.events.onTabsChanged();
  }

  #onTabEvent(tabId: number, method: string, params: JsonObject): void {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") {
      const frame = method === "Page.frameNavigated" ? params.frame : params;
      if (
        typeof frame === "object" &&
        frame !== null &&
        !Array.isArray(frame) &&
        (method !== "Page.frameNavigated" || !("parentId" in frame)) &&
        typeof frame.url === "string"
      ) {
        this.#tabs.set(tabId, { ...tab, url: frame.url });
        this.events.onTabsChanged();
      }
    }
    this.events.onTabEvent(tabId, method, params);
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#teardown("Extension bridge went silent");
      this.#socket.close(1001, "idle");
    }, IDLE_TIMEOUT_MS);
  }

  #trySend(message: WireMessage): void {
    try {
      this.#send(message);
    } catch {
      /* socket already unusable */
    }
  }

  #deny(code: ErrorCode, reason: string, closeReason = "unauthorized"): void {
    void this.#log.error(`${this.#label}: handshake denied (${code}): ${reason}`);
    this.#trySend({
      type: "error",
      version: PROTOCOL_VERSION,
      error: { code, message: reason },
    });
    this.#teardown(reason);
    this.#socket.close(1008, closeReason);
  }

  #protocolError(reason: string): void {
    void this.#log.error(`${this.#label}: protocol error, closing: ${reason}`);
    this.#teardown(reason);
    this.#socket.close(1002, reason);
  }

  #teardown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#handshakeTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const wasReady = this.#ready;
    this.#ready = false;
    if (wasReady) {
      for (const tabId of this.#tabs.keys()) this.events.onTabRemoved(tabId);
      this.#tabs.clear();
      this.events.onTabsChanged();
    }
    this.#pending.rejectAll(new BrowserUseError("BRIDGE_DISCONNECTED", reason));
    this.events.onClose(this);
  }
}
