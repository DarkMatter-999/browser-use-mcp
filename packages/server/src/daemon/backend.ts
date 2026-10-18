import type {
  BackendCapabilities,
  ConnectedTab,
  DownloadInfo,
  JsonObject,
  JsonValue,
} from "@browser-use/protocol";

export type CdpEventListener = (method: string, params: JsonObject) => void;

export interface BrowserBackend {
  readonly kind: "extension" | "headless";
  readonly capabilities: BackendCapabilities;
  readonly browserName?: string;
  /** Release resources owned by this backend. ExtensionBackend does not own the bridge. */
  close(): Promise<void>;
  isConnected(): boolean;
  listTabs(): ConnectedTab[];
  listDownloads(): DownloadInfo[];
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  isFileAccessAllowed(): Promise<boolean>;
  sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs: number,
  ): Promise<JsonValue>;
  subscribe(tabId: number, listener: CdpEventListener): () => void;
  onTabsChanged(listener: (tabs: ConnectedTab[]) => void): () => void;
  onTabRemoved(listener: (tabId: number) => void): () => void;
  onDownloadsChanged(listener: (downloads: DownloadInfo[]) => void): () => void;
}
