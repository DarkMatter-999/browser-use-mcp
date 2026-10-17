import "./zod-jitless";
import {
  BrowserUseError,
  type ErrorPayload,
  jsonObjectSchema,
  type JsonValue,
  jsonValueSchema,
  type PendingDialog,
  PROTOCOL_VERSION,
  pendingDialogSchema,
  type WireMessage,
} from "@browser-use/protocol";
import { z } from "zod";
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
  adapter: Pick<DebuggerAdapter, "attach" | "detach" | "sendCommand" | "reattach">;
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
  /**
   * Survives service-worker restarts (chrome.storage.session): which tabs are connected, whether
   * the agent opened them, and any open dialog. `load` returns unvalidated stored data.
   */
  session?: { load(): Promise<unknown>; save(tabs: PersistedTab[]): Promise<void> };
  /** Download correlation: only downloads a connected tab starts reach the daemon. */
  downloads?: { expect(url: string): void };
  graceMs?: number;
}

export interface PersistedTab {
  tabId: number;
  auto: boolean;
  dialog?: PendingDialog;
}

const persistedTabsSchema = z.array(
  z.object({
    tabId: z.number().int().positive(),
    auto: z.boolean(),
    dialog: pendingDialogSchema.optional(),
  }),
);

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

const MAX_ERROR_MESSAGE_CHARS = 4_000;

/** A schema-valid error payload: the wire requires a non-empty message (Chrome can send ""). */
function errorPayload(error: unknown): ErrorPayload {
  const payload =
    error instanceof BrowserUseError
      ? error.toPayload()
      : new BrowserUseError("INTERNAL", messageOf(error)).toPayload();
  const text = payload.message.trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
  return { ...payload, message: text === "" ? "Chrome reported an error without a message" : text };
}

export class Controller {
  readonly #connected = new Set<number>();
  readonly #auto = new Set<number>();
  readonly #status = new TabStatus();
  readonly #lifecycle = new TabLifecycle();
  readonly #errors = new Map<number, string>();
  readonly #dialogs = new Map<number, PendingDialog>();
  #saving: Promise<void> = Promise.resolve();
  #bridgeDetail: string | undefined;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  /**
   * Run once when the service worker starts, before the bridge connects. MV3 can stop and
   * restart the worker at any time; debugger sessions may outlive it. Tabs that were connected
   * and are still attached are adopted again (spec section 10) and re-registered once the
   * bridge is ready; stale entries are dropped.
   */
  async restore(): Promise<void> {
    const session = this.deps.session;
    if (!session) return;
    let saved: PersistedTab[];
    try {
      const parsed = persistedTabsSchema.safeParse(await session.load());
      saved = parsed.success ? parsed.data : [];
    } catch {
      return;
    }
    if (saved.length === 0) return;
    let adopted: number[] = [];
    try {
      adopted = await this.deps.adapter.reattach(saved.map((entry) => entry.tabId));
    } catch {
      adopted = [];
    }
    for (const entry of saved) {
      if (!adopted.includes(entry.tabId)) continue;
      this.#connected.add(entry.tabId);
      if (entry.auto) this.#auto.add(entry.tabId);
      if (entry.dialog) this.#dialogs.set(entry.tabId, entry.dialog);
      this.#status.set(entry.tabId, "connected");
    }
    this.#persist();
    if (this.deps.bridge.state === "ready") await this.#reregisterAll();
  }

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
    if (method === "Page.downloadWillBegin" && typeof params.url === "string") {
      this.deps.downloads?.expect(params.url);
    }
    this.#trackDialog(tabId, method, params);
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
        this.#persist();
        await this.#register(tabId);
        this.#status.set(tabId, "connected");
      } catch (error) {
        this.#connected.delete(tabId);
        this.#auto.delete(tabId);
        this.#persist();
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
        this.#persist();
        this.#status.set(tabId, "connected");
        await this.#register(tabId);
      } catch (error) {
        this.#connected.delete(tabId);
        this.#auto.delete(tabId);
        this.#persist();
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

  /** Mirrors the daemon's DialogTracker so registerTab can report a dialog it missed. */
  #trackDialog(tabId: number, method: string, params: Record<string, unknown>): void {
    if (method === "Page.javascriptDialogOpening") {
      const parsed = pendingDialogSchema.safeParse({
        type: params.type,
        message: params.message ?? "",
        url: params.url ?? "",
        ...(typeof params.defaultPrompt === "string"
          ? { defaultPrompt: params.defaultPrompt }
          : {}),
      });
      if (parsed.success) {
        this.#dialogs.set(tabId, parsed.data);
        this.#persist();
      }
    } else if (method === "Page.javascriptDialogClosed" && this.#dialogs.delete(tabId)) {
      this.#persist();
    }
  }

  #persist(): void {
    const session = this.deps.session;
    if (!session) return;
    const tabs: PersistedTab[] = [...this.#connected].map((tabId) => {
      const dialog = this.#dialogs.get(tabId);
      return { tabId, auto: this.#auto.has(tabId), ...(dialog ? { dialog } : {}) };
    });
    // Chained so writes land in order; a failed write must not block later ones.
    this.#saving = this.#saving.then(() => session.save(tabs)).catch(() => undefined);
  }

  async #register(tabId: number, known?: TabInfo): Promise<void> {
    const tab = known ?? (await this.deps.tabs.get(tabId));
    const pendingDialog = this.#dialogs.get(tabId);
    this.#send({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId,
      url: tab.url ?? "about:blank",
      title: tab.title ?? "",
      ...(tab.active === undefined ? {} : { active: tab.active }),
      ...(this.#auto.has(tabId) ? { autoConnected: true } : {}),
      ...(pendingDialog ? { pendingDialog } : {}),
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
    this.#dialogs.delete(tabId);
    this.#persist();
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
    let message: WireMessage;
    try {
      message = {
        type: "response",
        version: PROTOCOL_VERSION,
        requestId,
        result: toJson(await work()),
      };
    } catch (error) {
      message = { type: "error", version: PROTOCOL_VERSION, requestId, error: errorPayload(error) };
    }
    try {
      this.#send(message);
    } catch (error) {
      if (error instanceof BrowserUseError && error.code === "BRIDGE_DISCONNECTED") return;
      // The answer could not be sent (over the 2 MiB limit, or not serialisable). Always answer
      // so the daemon's request fails fast instead of waiting for its timeout.
      const tooLarge = error instanceof BrowserUseError && error.code === "LIMIT_EXCEEDED";
      this.#safeSend({
        type: "error",
        version: PROTOCOL_VERSION,
        requestId,
        error: tooLarge
          ? {
              code: "LIMIT_EXCEEDED",
              message: "Response exceeds the 2 MiB bridge limit",
              hint: "Ask for less data: a smaller page region, fewer nodes, or a narrower query.",
            }
          : {
              code: "INTERNAL",
              message: `Response could not be sent: ${messageOf(error).slice(0, 500)}`,
            },
      });
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
