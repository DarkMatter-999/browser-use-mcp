import {
  BrowserUseError,
  type ConnectedTab,
  type DownloadInfo,
  type JsonObject,
  type JsonValue,
  type PendingDialog,
  type WireMessage,
} from "@browser-use/protocol";
import type { BrowserBackend, CdpEventListener } from "./backend";
import type { BridgeServer } from "./bridge-server";
import { DialogTracker } from "./dialog-tracker";

type DownloadMessage = Extract<WireMessage, { type: "download" }>;

function dialogOpenError(dialog: PendingDialog): BrowserUseError {
  return new BrowserUseError(
    "DIALOG_OPEN",
    `A ${dialog.type} dialog is open: "${dialog.message}"`,
    {
      hint: "Call browser_handle_dialog with accept true or false.",
      details: {
        type: dialog.type,
        message: dialog.message,
        url: dialog.url,
        ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
      },
    },
  );
}

export class ExtensionBackend implements BrowserBackend {
  readonly kind = "extension" as const;
  readonly #bridge: BridgeServer;
  readonly #dialogs = new DialogTracker();
  readonly #subscribers = new Map<number, Set<CdpEventListener>>();
  readonly #tabListeners = new Set<(tabs: ConnectedTab[]) => void>();
  readonly #removedListeners = new Set<(tabId: number) => void>();
  readonly #downloadListeners = new Set<(downloads: DownloadInfo[]) => void>();
  readonly #downloads = new Map<number, DownloadInfo>();
  #sequence = 0;

  constructor(bridge: BridgeServer) {
    this.#bridge = bridge;
    bridge.on("tabsChanged", () => {
      this.#emitTabs();
    });
    bridge.on("tabRemoved", (tabId: number) => {
      this.#dialogs.clear(tabId);
      for (const listener of this.#removedListeners) listener(tabId);
      this.#emitTabs();
    });
    bridge.on("tabEvent", (tabId: number, method: string, params: JsonObject) => {
      this.#onTabEvent(tabId, method, params);
    });
    bridge.on("download", (message: DownloadMessage) => {
      this.#onDownload(message);
    });
  }

  isConnected(): boolean {
    return this.#bridge.peer !== undefined;
  }

  listTabs(): ConnectedTab[] {
    const peer = this.#bridge.peer;
    if (!peer) return [];
    return peer.listTabs().map((tab) => {
      const pendingDialog = this.#dialogs.get(tab.tabId);
      return pendingDialog ? { ...tab, pendingDialog } : tab;
    });
  }

  listDownloads(): DownloadInfo[] {
    return [...this.#downloads.values()].sort((a, b) => a.sequence - b.sequence);
  }

  openTab(url: string): Promise<number> {
    return this.#bridge.requirePeer().openTab(url);
  }

  closeTab(tabId: number): Promise<void> {
    return this.#bridge.requirePeer().closeTab(tabId);
  }

  isFileAccessAllowed(): Promise<boolean> {
    return this.#bridge.requirePeer().isFileAccessAllowed();
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs: number,
  ): Promise<JsonValue> {
    const peer = this.#bridge.requirePeer();
    const dialog = this.#dialogs.get(tabId);
    if (dialog && method !== "Page.handleJavaScriptDialog") throw dialogOpenError(dialog);
    return peer.sendCommand(tabId, method, params, timeoutMs);
  }

  subscribe(tabId: number, listener: CdpEventListener): () => void {
    const set = this.#subscribers.get(tabId) ?? new Set<CdpEventListener>();
    set.add(listener);
    this.#subscribers.set(tabId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#subscribers.get(tabId) === set) this.#subscribers.delete(tabId);
    };
  }

  onTabsChanged(listener: (tabs: ConnectedTab[]) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  onTabRemoved(listener: (tabId: number) => void): () => void {
    this.#removedListeners.add(listener);
    return () => this.#removedListeners.delete(listener);
  }

  onDownloadsChanged(listener: (downloads: DownloadInfo[]) => void): () => void {
    this.#downloadListeners.add(listener);
    return () => this.#downloadListeners.delete(listener);
  }

  #onTabEvent(tabId: number, method: string, params: JsonObject): void {
    const changed = this.#dialogs.onEvent(tabId, method, params);
    if (changed && method === "Page.javascriptDialogOpening") {
      const dialog = this.#dialogs.get(tabId);
      if (dialog) this.#bridge.peer?.failPendingForTab(tabId, dialogOpenError(dialog));
    }
    for (const listener of this.#subscribers.get(tabId) ?? []) listener(method, params);
    if (changed) this.#emitTabs();
  }

  #onDownload(message: DownloadMessage): void {
    const { downloadId, filename, url, state, bytesReceived, totalBytes, error } = message;
    this.#downloads.set(downloadId, {
      downloadId,
      filename,
      url,
      state,
      bytesReceived,
      totalBytes,
      ...(error === undefined ? {} : { error }),
      sequence: ++this.#sequence,
    });
    const snapshot = this.listDownloads();
    for (const listener of this.#downloadListeners) listener(snapshot);
  }

  #emitTabs(): void {
    const tabs = this.listTabs();
    for (const listener of this.#tabListeners) listener(tabs);
  }
}
