import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedTab, DownloadInfo, JsonObject, JsonValue } from "@browser-use/protocol";
import { type Paths, resolvePaths } from "../../src/config";
import type { BrowserBackend, CdpEventListener } from "../../src/daemon/backend";
import { IpcServer } from "../../src/daemon/ipc-server";
import type { Logger } from "../../src/daemon/log";
import { PairingCodes } from "../../src/daemon/token-store";

export class StubBackend implements BrowserBackend {
  readonly kind = "extension" as const;
  tabs: ConnectedTab[] = [];
  downloads: DownloadInfo[] = [];
  commands: { tabId: number; method: string; params: JsonObject }[] = [];
  listeners = new Map<number, Set<CdpEventListener>>();
  tabListeners = new Set<(tabs: ConnectedTab[]) => void>();
  removedListeners = new Set<(tabId: number) => void>();
  downloadListeners = new Set<(downloads: DownloadInfo[]) => void>();
  connected = true;
  isConnected() {
    return this.connected;
  }
  listTabs() {
    return this.tabs;
  }
  listDownloads() {
    return this.downloads;
  }
  openTab(): Promise<number> {
    return Promise.resolve(77);
  }
  closeTab(): Promise<void> {
    return Promise.resolve();
  }
  isFileAccessAllowed() {
    return Promise.resolve(true);
  }
  sendCommand(tabId: number, method: string, params: JsonObject): Promise<JsonValue> {
    this.commands.push({ tabId, method, params });
    return Promise.resolve({ echoed: method });
  }
  subscribe(tabId: number, listener: CdpEventListener) {
    const set = this.listeners.get(tabId) ?? new Set();
    set.add(listener);
    this.listeners.set(tabId, set);
    return () => set.delete(listener);
  }
  onTabsChanged(listener: (tabs: ConnectedTab[]) => void) {
    this.tabListeners.add(listener);
    return () => this.tabListeners.delete(listener);
  }
  onTabRemoved(listener: (tabId: number) => void) {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }
  onDownloadsChanged(listener: (d: DownloadInfo[]) => void) {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }
  emitTabs() {
    for (const l of this.tabListeners) l(this.tabs);
  }
  emitEvent(tabId: number, method: string, params: JsonObject) {
    for (const l of this.listeners.get(tabId) ?? []) l(method, params);
  }
}

export async function startInProcessDaemon(
  version = "1.0.0",
  options: { paths?: Paths; closeOnShutdown?: boolean; log?: Logger; drainTimeoutMs?: number } = {},
) {
  const ownsHome = options.paths === undefined;
  const home = options.paths?.home ?? (await mkdtemp(join(tmpdir(), "bu-")));
  const paths: Paths = options.paths ?? resolvePaths({ BROWSER_USE_HOME: home });
  const backend = new StubBackend();
  const pairing = new PairingCodes();
  let rotations = 0;
  let shutdowns = 0;
  const server: IpcServer = new IpcServer({
    backend,
    pairing,
    daemonVersion: version,
    port: 38241,
    rotateToken: () => {
      rotations += 1;
      return Promise.resolve();
    },
    onShutdown: () => {
      shutdowns += 1;
      if (options.closeOnShutdown) void server.close();
    },
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  await mkdir(home, { recursive: true });
  await server.listen(paths.ipcEndpoint);
  return {
    paths,
    backend,
    pairing,
    server,
    get rotations() {
      return rotations;
    },
    get shutdowns() {
      return shutdowns;
    },
    async stop() {
      await server.close();
      if (ownsHome) await rm(home, { recursive: true, force: true });
    },
  };
}
