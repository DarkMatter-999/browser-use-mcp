import "./zod-jitless";
import {
  BrowserUseError,
  jsonObjectSchema,
  type JsonValue,
  jsonValueSchema,
  PROTOCOL_VERSION,
  type WireMessage,
} from "@browser-use/protocol";
import type { BridgeState } from "./bridge/client";
import type { DebuggerAdapter } from "./cdp/debugger-adapter";
import { targetTabIdForConnect } from "./tabs/connect-target";
import { TabLifecycle } from "./tabs/lifecycle";
import { type TabConnectionState, TabStatus } from "./tabs/status";

export interface TabInfo {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
}

export interface ControllerDeps {
  bridge: {
    readonly state: BridgeState;
    send(message: WireMessage): void;
    pair(code: string): Promise<void>;
  };
  adapter: Pick<DebuggerAdapter, "attach" | "detach" | "sendCommand">;
  tabs: {
    get(tabId: number): Promise<TabInfo>;
    create(properties: { url: string; active?: boolean; windowId?: number }): Promise<{
      id?: number;
    }>;
    remove(tabId: number): Promise<void>;
    query(query: { active: true; lastFocusedWindow: true }): Promise<TabInfo[]>;
  };
  isAllowedFileSchemeAccess(): Promise<boolean>;
  addToGroup(tabId: number): Promise<void>;
  graceMs?: number;
}

export type PopupMessage =
  | { type: "get-status"; tabId?: number }
  | { type: "connect-active-tab" }
  | { type: "disconnect-tab"; tabId: number }
  | { type: "disconnect-all" }
  | { type: "pair"; code: string };

export interface PopupReply {
  bridge: BridgeState;
  bridgeDetail?: string;
  state: TabConnectionState;
  error?: string;
  connectedCount: number;
}

const DEFAULT_GRACE_MS = 5 * 60_000;

function toJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value ?? null)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Controller {
  readonly #connected = new Set<number>();
  readonly #auto = new Set<number>();
  readonly #status = new TabStatus();
  readonly #lifecycle = new TabLifecycle();
  readonly #errors = new Map<number, string>();
  #bridgeDetail: string | undefined;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  async onBridgeMessage(message: WireMessage): Promise<void> {
    switch (message.type) {
      case "command":
        return this.#handle(message.requestId, async () => {
          this.#requireConnected(message.tabId);
          return this.deps.adapter.sendCommand(message.tabId, message.method, message.params);
        });
      case "openTab":
        return this.#handle(message.requestId, () => this.#openTab(message.url));
      case "closeTab":
        return this.#handle(message.requestId, async () => {
          this.#requireConnected(message.tabId);
          await this.deps.tabs.remove(message.tabId);
          return { closed: true };
        });
      case "fileAccess":
        return this.#handle(message.requestId, async () => ({
          allowed: await this.deps.isAllowedFileSchemeAccess(),
        }));
      default:
        return;
    }
  }

  onBridgeState(state: BridgeState, detail?: string): void {
    this.#bridgeDetail = detail;
    if (state === "ready") {
      this.#clearGrace();
      void this.#reregisterAll();
      return;
    }
    if (state === "unpaired") {
      this.#clearGrace();
      this.#detachAll("Pairing was revoked");
      return;
    }
    if (this.#connected.size > 0 && this.#graceTimer === undefined) {
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = undefined;
        this.#detachAll("Local server unreachable");
      }, this.deps.graceMs ?? DEFAULT_GRACE_MS);
    }
  }

  onDebuggerEvent(tabId: number, method: string, params: Record<string, unknown>): void {
    if (!this.#connected.has(tabId)) return;
    try {
      this.#send({
        type: "event",
        version: PROTOCOL_VERSION,
        tabId,
        method,
        params: jsonObjectSchema.parse(JSON.parse(JSON.stringify(params))),
      });
    } catch {
      /* bridge unavailable or event not serialisable: drop it */
    }
  }

  onExternalDetach(tabId: number): void {
    void this.#disconnect(tabId, "Debugger detached");
  }

  onTabRemoved(tabId: number): void {
    void this.#disconnect(tabId, "Tab closed");
    this.#status.remove(tabId);
    this.#errors.delete(tabId);
  }

  async onTabUpdated(tabId: number): Promise<void> {
    if (!this.#connected.has(tabId)) return;
    try {
      await this.#register(tabId);
    } catch {
      /* tab gone or bridge down: lifecycle events handle cleanup */
    }
  }

  async onPopupMessage(message: PopupMessage): Promise<PopupReply> {
    let tabId: number | undefined;
    let error: string | undefined;
    try {
      switch (message.type) {
        case "get-status":
          tabId = message.tabId;
          break;
        case "connect-active-tab":
          tabId = await this.#connectActive();
          break;
        case "disconnect-tab":
          tabId = message.tabId;
          await this.#lifecycle.disconnect(tabId, () =>
            this.#disconnect(message.tabId, "Disconnected"),
          );
          break;
        case "disconnect-all":
          await Promise.all(
            [...this.#connected].map((id) =>
              this.#lifecycle.disconnect(id, () => this.#disconnect(id, "Disconnected")),
            ),
          );
          break;
        case "pair":
          await this.deps.bridge.pair(message.code);
          break;
      }
    } catch (caught) {
      error = messageOf(caught);
    }
    return this.#reply(tabId, error);
  }

  #reply(tabId: number | undefined, error: string | undefined): PopupReply {
    const state = tabId === undefined ? "disconnected" : this.#status.get(tabId);
    const message =
      error ?? (state === "error" && tabId !== undefined ? this.#errors.get(tabId) : undefined);
    return {
      bridge: this.deps.bridge.state,
      ...(this.#bridgeDetail === undefined ? {} : { bridgeDetail: this.#bridgeDetail }),
      state,
      ...(message === undefined ? {} : { error: message }),
      connectedCount: this.#connected.size,
    };
  }

  async #connectActive(): Promise<number | undefined> {
    const bridgeState = this.deps.bridge.state;
    if (bridgeState === "unpaired") {
      throw new BrowserUseError("NOT_PAIRED", "Enter the pairing code first");
    }
    if (bridgeState !== "ready") {
      throw new BrowserUseError(
        "BRIDGE_DISCONNECTED",
        "Start an MCP client or run `browseruse-mcp status`",
      );
    }
    const [active] = await this.deps.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) throw new BrowserUseError("TAB_NOT_CONNECTED", "No active tab");
    const tabId = await targetTabIdForConnect(active, (properties) =>
      this.deps.tabs.create(properties),
    );
    await this.#lifecycle.connect(tabId, async () => {
      if (this.#connected.has(tabId)) return;
      this.#status.set(tabId, "connecting");
      this.#errors.delete(tabId);
      try {
        await this.deps.adapter.attach(tabId);
        this.#connected.add(tabId);
        await this.#register(tabId);
        this.#status.set(tabId, "connected");
      } catch (error) {
        this.#connected.delete(tabId);
        this.#auto.delete(tabId);
        this.#status.set(tabId, "error");
        this.#errors.set(tabId, messageOf(error));
        await this.#safeDetach(tabId);
      }
    });
    return tabId;
  }

  async #openTab(url: string): Promise<JsonValue> {
    const created = await this.deps.tabs.create({ url, active: false });
    if (created.id === undefined) {
      throw new BrowserUseError("INTERNAL", "Chrome did not return an ID for the new tab");
    }
    const tabId = created.id;
    await this.#lifecycle.connect(tabId, async () => {
      try {
        await this.deps.adapter.attach(tabId);
        this.#connected.add(tabId);
        this.#auto.add(tabId);
        this.#status.set(tabId, "connected");
        await this.#register(tabId);
      } catch (error) {
        this.#connected.delete(tabId);
        this.#auto.delete(tabId);
        this.#status.remove(tabId);
        await this.#safeDetach(tabId);
        try {
          await this.deps.tabs.remove(tabId);
        } catch {
          /* best effort */
        }
        throw error;
      }
    });
    try {
      await this.deps.addToGroup(tabId);
    } catch {
      /* grouping is cosmetic */
    }
    return { tabId };
  }

  async #register(tabId: number, known?: TabInfo): Promise<void> {
    const tab = known ?? (await this.deps.tabs.get(tabId));
    this.#send({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId,
      url: tab.url ?? "about:blank",
      title: tab.title ?? "",
      ...(tab.active === undefined ? {} : { active: tab.active }),
      ...(this.#auto.has(tabId) ? { autoConnected: true } : {}),
    });
  }

  async #reregisterAll(): Promise<void> {
    for (const tabId of [...this.#connected]) {
      let tab: TabInfo;
      try {
        tab = await this.deps.tabs.get(tabId);
      } catch {
        await this.#disconnect(tabId, "Tab no longer exists");
        continue;
      }
      try {
        await this.#register(tabId, tab);
      } catch {
        return; // bridge dropped again; the next ready event retries
      }
    }
  }

  /** Idempotent. The bookkeeping and unregister happen synchronously so duplicate triggers collapse. */
  async #disconnect(tabId: number, reason: string): Promise<void> {
    if (!this.#connected.delete(tabId)) return;
    this.#auto.delete(tabId);
    this.#status.set(tabId, "disconnected");
    try {
      this.#send({ type: "unregisterTab", version: PROTOCOL_VERSION, tabId, reason });
    } catch {
      /* bridge unavailable */
    }
    await this.#safeDetach(tabId);
  }

  #detachAll(reason: string): void {
    for (const tabId of [...this.#connected]) void this.#disconnect(tabId, reason);
  }

  async #safeDetach(tabId: number): Promise<void> {
    try {
      await this.deps.adapter.detach(tabId);
    } catch {
      /* already detached */
    }
  }

  #requireConnected(tabId: number): void {
    if (!this.#connected.has(tabId)) {
      throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`);
    }
  }

  #clearGrace(): void {
    clearTimeout(this.#graceTimer);
    this.#graceTimer = undefined;
  }

  async #handle(requestId: string, work: () => Promise<unknown>): Promise<void> {
    try {
      this.#safeSend({
        type: "response",
        version: PROTOCOL_VERSION,
        requestId,
        result: toJson(await work()),
      });
    } catch (error) {
      const payload =
        error instanceof BrowserUseError
          ? error.toPayload()
          : new BrowserUseError("INTERNAL", messageOf(error)).toPayload();
      this.#safeSend({ type: "error", version: PROTOCOL_VERSION, requestId, error: payload });
    }
  }

  #send(message: WireMessage): void {
    this.deps.bridge.send(message);
  }

  #safeSend(message: WireMessage): void {
    try {
      this.deps.bridge.send(message);
    } catch {
      /* bridge went away before we could answer */
    }
  }
}
