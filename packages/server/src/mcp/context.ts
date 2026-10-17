import type {
  ConnectedTab,
  DaemonStatus,
  DownloadInfo,
  JsonObject,
  JsonValue,
} from "@browser-use/protocol";
import type { Pointer } from "../pointer/types";
import type { RefStore } from "../refs/types";

export type CdpListener = (method: string, params: JsonObject) => void;

export interface DaemonApi {
  listTabs(): ConnectedTab[];
  status(): Promise<DaemonStatus>;
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  isFileAccessAllowed(): Promise<boolean>;
  sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs?: number,
  ): Promise<JsonValue>;
  listDownloads(): Promise<DownloadInfo[]>;
  subscribe(tabId: number, listener: CdpListener): () => void;
  onTabRemoved(listener: (tabId: number) => void): () => void;
}

export interface ToolContext extends DaemonApi {
  refs: RefStore;
  pointer: Pointer;
}
