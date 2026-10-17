import type { ConnectedTab, DownloadInfo, JsonObject, JsonValue } from "@browser-use/protocol";

export type CdpEventListener = (method: string, params: JsonObject) => void;

export interface BrowserBackend {
  readonly kind: "extension";
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
