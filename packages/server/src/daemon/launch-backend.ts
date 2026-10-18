import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Page,
} from "playwright-core";
import {
  BrowserUseError,
  type ConnectedTab,
  type DownloadInfo,
  type JsonObject,
  type JsonValue,
  type PendingDialog,
  jsonValueSchema,
  pendingDialogSchema,
} from "@browser-use/protocol";
import type { BrowserProfile } from "../config";
import { discoverBrowser, type DiscoveredBrowser } from "./browser-discovery";
import { prepareProfileDirectory } from "./profile-directory";
import type { BrowserBackend, CdpEventListener } from "./backend";

export interface LaunchBackendOptions {
  profile: BrowserProfile;
  /** Persistent profile path for `default`; parent directory used for guest temp data. */
  profileDir: string;
  executablePath?: string;
  downloadDir: string;
}

type LaunchPersistentContext = (
  userDataDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;

export interface LaunchBackendDeps {
  discoverBrowser(): Promise<DiscoveredBrowser>;
  launchPersistentContext: LaunchPersistentContext;
  makeGuestProfileDir(persistentProfileDir: string): Promise<string>;
  removeGuestProfileDir(path: string): Promise<void>;
  verifyGuestProfile(
    context: BrowserContext,
    browser: DiscoveredBrowser,
    userDataDir: string,
  ): Promise<boolean>;
}

interface TabSession {
  page: Page;
  session: CDPSession;
  title: string;
}

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

function unsupportedGuestSession(cause?: unknown): BrowserUseError {
  return new BrowserUseError(
    "UNSUPPORTED_CAPABILITY",
    "The selected browser did not start an actual guest profile",
    {
      hint: "Use BROWSER_USE_PROFILE=default, or choose a browser build that supports guest mode.",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

async function verifyGuestProfile(
  context: BrowserContext,
  browser: DiscoveredBrowser,
  userDataDir: string,
): Promise<boolean> {
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  const temporaryPage = pages.length === 0;
  try {
    const versionPage =
      browser.browserName === "Microsoft Edge" ? "edge://version" : "chrome://version";
    await page.goto(versionPage);
    const profilePath = await page.locator("#profile_path").innerText({ timeout: 5_000 });
    return isGuestProfilePath(profilePath.trim(), userDataDir);
  } catch {
    return false;
  } finally {
    if (temporaryPage) await page.close().catch(() => undefined);
    else await page.goto("about:blank").catch(() => undefined);
  }
}

/**
 * Playwright launches a fresh user-data directory for guest mode. Chrome-family browsers create
 * the active guest profile as a non-Default direct child of that directory; the exact name can
 * vary by browser/version/locale, so validate the path relationship rather than a display label.
 */
export function isGuestProfilePath(
  profilePath: string,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathOps = platform === "win32" ? win32 : posix;
  const relativePath = pathOps.relative(pathOps.resolve(userDataDir), pathOps.resolve(profilePath));
  if (
    relativePath === "" ||
    pathOps.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${pathOps.sep}`) ||
    relativePath.includes(pathOps.sep)
  ) {
    return false;
  }
  return relativePath.toLowerCase() !== "default";
}

const defaultDeps = (executablePath?: string): LaunchBackendDeps => ({
  discoverBrowser: () =>
    discoverBrowser(process.platform, {
      ...process.env,
      ...(executablePath === undefined ? {} : { BROWSER_USE_CHROME_PATH: executablePath }),
    }),
  launchPersistentContext: (userDataDir, options) =>
    chromium.launchPersistentContext(userDataDir, options),
  makeGuestProfileDir: (profileDir) => mkdtemp(join(dirname(profileDir), "guest-")),
  removeGuestProfileDir: (path) => rm(path, { recursive: true, force: true }),
  verifyGuestProfile,
});

export class LaunchBackend implements BrowserBackend {
  readonly kind = "headless" as const;
  readonly capabilities = {
    cdp: true,
    downloads: true,
    dialogs: true,
    fileAccess: true,
    pointer: true,
  } as const;
  readonly browser: DiscoveredBrowser;
  readonly browserName: string;
  readonly profile: BrowserProfile;
  readonly #context: BrowserContext;
  readonly #deps: LaunchBackendDeps;
  readonly #guestProfileDir: string | undefined;
  readonly #downloadDir: string;
  readonly #tabs = new Map<number, TabSession>();
  readonly #dialogs = new Map<number, PendingDialog>();
  readonly #pendingCommands = new Map<number, Set<(error: BrowserUseError) => void>>();
  readonly #pageIds = new WeakMap<Page, Promise<number>>();
  readonly #tabListeners = new Set<(tabs: ConnectedTab[]) => void>();
  readonly #removedListeners = new Set<(tabId: number) => void>();
  readonly #downloadListeners = new Set<(downloads: DownloadInfo[]) => void>();
  readonly #downloads = new Map<number, DownloadInfo>();
  readonly #disconnected: Promise<void>;
  #resolveDisconnected!: () => void;
  #nextTabId = 0;
  #downloadSequence = 0;
  #connected = true;
  #closePromise: Promise<void> | undefined;

  private constructor(
    context: BrowserContext,
    browser: DiscoveredBrowser,
    profile: BrowserProfile,
    downloadDir: string,
    deps: LaunchBackendDeps,
    guestProfileDir: string | undefined,
  ) {
    this.#context = context;
    this.browser = browser;
    this.browserName = browser.browserName;
    this.profile = profile;
    this.#downloadDir = downloadDir;
    this.#deps = deps;
    this.#guestProfileDir = guestProfileDir;
    this.#disconnected = new Promise((resolve) => {
      this.#resolveDisconnected = resolve;
    });
    context.on("page", (page) => {
      void this.#registerPage(page);
    });
    context.on("close", () => {
      this.#markDisconnected();
    });
  }

  static async create(
    options: LaunchBackendOptions,
    deps: Partial<LaunchBackendDeps> = {},
  ): Promise<LaunchBackend> {
    const runtimeDeps = { ...defaultDeps(options.executablePath), ...deps };
    const browser = await runtimeDeps.discoverBrowser();
    let profileDir = options.profileDir;
    let guestProfileDir: string | undefined;
    if (options.profile === "guest") {
      guestProfileDir = await runtimeDeps.makeGuestProfileDir(options.profileDir);
      profileDir = guestProfileDir;
    }

    let launchedContext: BrowserContext | undefined;
    try {
      await prepareProfileDirectory(profileDir);
      await mkdir(options.downloadDir, { recursive: true, mode: 0o700 });
      try {
        launchedContext = await runtimeDeps.launchPersistentContext(profileDir, {
          executablePath: browser.executablePath,
          headless: true,
          acceptDownloads: true,
          args: options.profile === "guest" ? ["--guest"] : [],
        });
      } catch (error) {
        if (options.profile === "guest") throw unsupportedGuestSession(error);
        throw error;
      }
      if (
        options.profile === "guest" &&
        !(await runtimeDeps.verifyGuestProfile(launchedContext, browser, profileDir))
      ) {
        throw unsupportedGuestSession();
      }
      const backend = new LaunchBackend(
        launchedContext,
        browser,
        options.profile,
        options.downloadDir,
        runtimeDeps,
        guestProfileDir,
      );
      await Promise.all(launchedContext.pages().map((page) => backend.#registerPage(page)));
      return backend;
    } catch (error) {
      if (launchedContext) await launchedContext.close().catch(() => undefined);
      if (guestProfileDir)
        await runtimeDeps.removeGuestProfileDir(guestProfileDir).catch(() => undefined);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.#connected;
  }

  listTabs(): ConnectedTab[] {
    return [...this.#tabs.entries()].map(([tabId, tab]) => {
      const pendingDialog = this.#dialogs.get(tabId);
      return {
        tabId,
        url: tab.page.url() || "about:blank",
        title: tab.title,
        ...(pendingDialog === undefined ? {} : { pendingDialog }),
      };
    });
  }

  listDownloads(): DownloadInfo[] {
    return [...this.#downloads.values()].sort((a, b) => a.sequence - b.sequence);
  }

  async openTab(url: string): Promise<number> {
    this.#requireConnected();
    const page = await this.#context.newPage();
    const tabId = await this.#registerPage(page);
    await page.goto(url);
    const tab = this.#tabs.get(tabId);
    if (tab) tab.title = await page.title().catch(() => "");
    this.#emitTabs();
    return tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    this.#requireConnected();
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`);
    await tab.page.close();
    await this.#removeTab(tabId);
  }

  isFileAccessAllowed(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: JsonObject,
    timeoutMs: number,
  ): Promise<JsonValue> {
    this.#requireConnected();
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`);
    const dialog = this.#dialogs.get(tabId);
    if (dialog && method !== "Page.handleJavaScriptDialog") throw dialogOpenError(dialog);
    let timeout: NodeJS.Timeout | undefined;
    let pendingCommands = this.#pendingCommands.get(tabId);
    if (!pendingCommands) {
      pendingCommands = new Set();
      this.#pendingCommands.set(tabId, pendingCommands);
    }
    let rejectForDialog: (error: BrowserUseError) => void = () => undefined;
    const dialogPromise = new Promise<never>((_, reject) => {
      rejectForDialog = (error) => {
        reject(error);
      };
    });
    const rejectCommand = (error: BrowserUseError): void => {
      rejectForDialog(error);
    };
    pendingCommands.add(rejectCommand);
    const timed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new BrowserUseError("TIMEOUT", `CDP command ${method} timed out`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        tab.session.send(method as never, params as never),
        timed,
        dialogPromise,
        this.#disconnected.then(() => {
          throw this.#disconnectedError();
        }),
      ]);
      const serialized = JSON.stringify(result);
      return jsonValueSchema.parse(JSON.parse(serialized));
    } catch (error) {
      if (!this.#connected) throw this.#disconnectedError();
      if (error instanceof BrowserUseError) throw error;
      throw new BrowserUseError("BRIDGE_DISCONNECTED", `CDP command ${method} failed`, {
        hint: "The launched browser may have exited. Restart the Browser Use daemon and try again.",
        cause: error,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      pendingCommands.delete(rejectCommand);
      if (pendingCommands.size === 0) this.#pendingCommands.delete(tabId);
    }
  }

  subscribe(tabId: number, listener: CdpEventListener): () => void {
    const tab = this.#tabs.get(tabId);
    if (!tab) return () => undefined;
    const callback = (event: { method: string; params?: object }): void => {
      listener(event.method, (event.params ?? {}) as JsonObject);
    };
    tab.session.on("event", callback);
    return () => {
      tab.session.off("event", callback);
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

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      this.#markDisconnected();
      await this.#context.close().catch(() => undefined);
      if (this.#guestProfileDir) {
        await this.#deps.removeGuestProfileDir(this.#guestProfileDir).catch(() => undefined);
      }
    })();
    return this.#closePromise;
  }

  async #registerPage(page: Page): Promise<number> {
    const previous = this.#pageIds.get(page);
    if (previous) return previous;
    const pending = (async () => {
      const session = await this.#context.newCDPSession(page);
      const tabId = ++this.#nextTabId;
      this.#tabs.set(tabId, { page, session, title: await page.title().catch(() => "") });
      session.on("event", (event) => {
        this.#onPageEvent(tabId, event);
      });
      await session.send("Page.enable", {});
      // Playwright auto-dismisses dialogs unless a listener is registered; leave handling to the MCP tool.
      page.on("dialog", () => undefined);
      page.on("download", (download) => {
        void this.#trackDownload(download);
      });
      page.on("close", () => {
        void this.#removeTab(tabId);
      });
      this.#emitTabs();
      return tabId;
    })();
    this.#pageIds.set(page, pending);
    return pending;
  }

  async #trackDownload(download: Download): Promise<void> {
    const downloadId = ++this.#downloadSequence;
    const suggestedFilename = download
      .suggestedFilename()
      .replaceAll("\\", "/")
      .replaceAll("\0", "_");
    const safeFilename = basename(suggestedFilename) || "download";
    const filename = join(this.#downloadDir, `${downloadId}-${safeFilename}`);
    const initial: DownloadInfo = {
      downloadId,
      filename,
      url: download.url(),
      state: "in_progress",
      bytesReceived: 0,
      totalBytes: -1,
      sequence: downloadId,
    };
    this.#downloads.set(downloadId, initial);
    this.#emitDownloads();
    let failure = await download.failure().catch(() => "download failed");
    failure ??= await download
      .saveAs(filename)
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    let bytesReceived = 0;
    if (!failure)
      bytesReceived = await stat(filename)
        .then((info) => info.size)
        .catch(() => 0);
    this.#downloads.set(downloadId, {
      ...initial,
      state: failure ? "interrupted" : "complete",
      bytesReceived,
      totalBytes: bytesReceived,
      filename,
      ...(failure ? { error: failure } : {}),
    });
    this.#emitDownloads();
  }

  async #removeTab(tabId: number): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    const error = new BrowserUseError(
      "BRIDGE_DISCONNECTED",
      `Tab ${tabId} closed while a command was pending`,
      { hint: "Open the tab again and retry the command." },
    );
    this.#rejectPendingCommands(tabId, error);
    this.#tabs.delete(tabId);
    this.#dialogs.delete(tabId);
    await tab.session.detach().catch(() => undefined);
    for (const listener of this.#removedListeners) listener(tabId);
    this.#emitTabs();
  }

  #emitTabs(): void {
    const tabs = this.listTabs();
    for (const listener of this.#tabListeners) listener(tabs);
  }

  #onPageEvent(tabId: number, event: { method: string; params?: object }): void {
    const params = (event.params ?? {}) as JsonObject;
    if (event.method === "Page.javascriptDialogOpening") {
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
        const error = dialogOpenError(parsed.data);
        for (const reject of this.#pendingCommands.get(tabId) ?? []) reject(error);
        this.#emitTabs();
      }
    } else if (event.method === "Page.javascriptDialogClosed" && this.#dialogs.delete(tabId)) {
      this.#emitTabs();
    }
  }

  #emitDownloads(): void {
    const downloads = this.listDownloads();
    for (const listener of this.#downloadListeners) listener(downloads);
  }

  #requireConnected(): void {
    if (!this.#connected) throw this.#disconnectedError();
  }

  #disconnectedError(): BrowserUseError {
    return new BrowserUseError("BRIDGE_DISCONNECTED", "The launched browser is not connected", {
      hint: "Check the daemon log, then restart the Browser Use daemon.",
    });
  }

  #rejectPendingCommands(tabId: number, error: BrowserUseError): void {
    for (const reject of this.#pendingCommands.get(tabId) ?? []) reject(error);
    this.#pendingCommands.delete(tabId);
  }

  #markDisconnected(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#resolveDisconnected();
    for (const [tabId, tab] of this.#tabs) {
      this.#rejectPendingCommands(tabId, this.#disconnectedError());
      this.#tabs.delete(tabId);
      this.#dialogs.delete(tabId);
      void tab.session.detach().catch(() => undefined);
      for (const listener of this.#removedListeners) listener(tabId);
    }
    this.#emitTabs();
  }
}
