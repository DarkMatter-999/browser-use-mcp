import { InMemoryRefStore } from "../refs/ref-store";
import { NullPointer } from "../pointer/null-pointer";
import { OverlayPointer } from "../pointer/overlay-pointer";
import type { DaemonApi, ToolContext } from "./context";

export function createToolContext(api: DaemonApi, options: { pointer: boolean }): ToolContext {
  return {
    listTabs: () => api.listTabs(),
    status: () => api.status(),
    openTab: (url) => api.openTab(url),
    closeTab: (tabId) => api.closeTab(tabId),
    isFileAccessAllowed: () => api.isFileAccessAllowed(),
    sendCommand: (tabId, method, params, timeoutMs) =>
      api.sendCommand(tabId, method, params, timeoutMs),
    listDownloads: () => api.listDownloads(),
    subscribe: (tabId, listener) => api.subscribe(tabId, listener),
    onTabRemoved: (listener) => api.onTabRemoved(listener),
    refs: new InMemoryRefStore(),
    pointer: options.pointer ? new OverlayPointer(api, true) : new NullPointer(),
  };
}
