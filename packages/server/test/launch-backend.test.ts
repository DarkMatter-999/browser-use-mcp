import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { LaunchBackend, type LaunchBackendDeps } from "../src/daemon/launch-backend";

class FakeSession extends EventEmitter {
  readonly commands: { method: string; params: Record<string, unknown> }[] = [];

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    return Promise.resolve({ ok: true });
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }
}

class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  closed = false;

  url(): string {
    return this.currentUrl;
  }

  title(): Promise<string> {
    return Promise.resolve("Test page");
  }

  goto(url: string): Promise<void> {
    this.currentUrl = url;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.emit("close");
    return Promise.resolve();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeContext extends EventEmitter {
  readonly openedPages = [new FakePage()];
  readonly sessions = new Map<FakePage, FakeSession>();
  closed = false;

  pages(): FakePage[] {
    return this.openedPages.filter((page) => !page.closed);
  }

  newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.openedPages.push(page);
    this.emit("page", page);
    return Promise.resolve(page);
  }

  newCDPSession(page: FakePage): Promise<FakeSession> {
    const session = new FakeSession();
    this.sessions.set(page, session);
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function pageAt(context: FakeContext, index: number): FakePage {
  const page = context.openedPages[index];
  if (!page) throw new Error(`Missing fake page at index ${index}`);
  return page;
}

describe("LaunchBackend", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createFixture(profile: "default" | "guest" = "default") {
    const home = await mkdtemp(join(tmpdir(), "bu-launch-test-"));
    tempDirs.push(home);
    const context = new FakeContext();
    const launchCalls: {
      profileDir: string;
      options: Parameters<LaunchBackendDeps["launchPersistentContext"]>[1];
    }[] = [];
    const launchPersistentContext: LaunchBackendDeps["launchPersistentContext"] = (
      profileDir,
      options,
    ) => {
      launchCalls.push({ profileDir, options });
      return Promise.resolve(context as unknown as BrowserContext);
    };
    const backend = await LaunchBackend.create(
      {
        profile,
        profileDir: join(home, "profile"),
        executablePath: "/usr/bin/chromium",
        downloadDir: join(home, "downloads"),
      },
      {
        discoverBrowser: () =>
          Promise.resolve({
            executablePath: "/usr/bin/chromium",
            browserName: "Chromium",
          }),
        launchPersistentContext,
        makeGuestProfileDir: () => Promise.resolve(join(home, "guest-session")),
        verifyGuestProfile: () => Promise.resolve(true),
      },
    );
    return { backend, context, launchCalls, home };
  }

  it("launches headless over a pipe without a debugging TCP port", async () => {
    const { backend, launchCalls } = await createFixture();
    const options = launchCalls[0]?.options;

    expect(options).toMatchObject({
      executablePath: "/usr/bin/chromium",
      headless: true,
    });
    expect(options?.args?.join(" ")).not.toContain("--remote-debugging-port");
    await backend.close();
  });

  it("opens, lists, commands, subscribes to events, and closes daemon-local tabs", async () => {
    const { backend, context } = await createFixture();
    const changes: number[][] = [];
    backend.onTabsChanged((tabs) => changes.push(tabs.map((tab) => tab.tabId)));

    const tabId = await backend.openTab("https://example.com/");
    expect(backend.listTabs()).toHaveLength(2);
    expect(backend.listTabs().find((tab) => tab.tabId === tabId)?.url).toBe("https://example.com/");
    await expect(
      backend.sendCommand(tabId, "Runtime.evaluate", { expression: "1 + 1" }, 1000),
    ).resolves.toEqual({ ok: true });

    const events: unknown[] = [];
    const unsubscribe = backend.subscribe(tabId, (method, params) => {
      events.push({ method, params });
    });
    const session = context.sessions.get(pageAt(context, 1));
    if (!session) throw new Error("Expected the tab to have a CDP session");
    session.emit("event", {
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
    });
    expect(events).toEqual([{ method: "Page.loadEventFired", params: { timestamp: 1 } }]);
    unsubscribe();

    await backend.closeTab(tabId);
    expect(backend.listTabs()).toHaveLength(1);
    expect(changes.at(-1)).toEqual([1]);
    await backend.close();
  });

  it("uses a separate disposable profile for guest mode", async () => {
    const { backend, launchCalls } = await createFixture("guest");
    const profileDir = launchCalls[0]?.profileDir;
    const options = launchCalls[0]?.options;

    expect(profileDir).toContain("guest-session");
    expect(profileDir).not.toContain("/profile");
    expect(options?.args).toContain("--guest");
    await backend.close();
  });

  it("turns unsupported guest launch failures into an actionable capability error", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-guest-test-"));
    tempDirs.push(home);
    const removeGuestProfileDir = vi.fn(() => Promise.resolve());

    await expect(
      LaunchBackend.create(
        {
          profile: "guest",
          profileDir: join(home, "profile"),
          executablePath: "/usr/bin/chromium",
          downloadDir: join(home, "downloads"),
        },
        {
          discoverBrowser: () =>
            Promise.resolve({
              executablePath: "/usr/bin/chromium",
              browserName: "Chromium",
            }),
          launchPersistentContext: () => Promise.reject(new Error("Guest sessions are disabled")),
          makeGuestProfileDir: () => Promise.resolve(join(home, "guest-session")),
          removeGuestProfileDir,
          verifyGuestProfile: () => Promise.resolve(true),
        },
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      hint: expect.stringMatching(/supports guest mode/i) as string,
    });
    expect(removeGuestProfileDir).toHaveBeenCalledWith(join(home, "guest-session"));
  });

  it("rejects a browser that ignores the guest flag and closes the launched process", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-guest-verify-"));
    tempDirs.push(home);
    const context = new FakeContext();
    const removeGuestProfileDir = vi.fn(() => Promise.resolve());
    const launchPersistentContext: LaunchBackendDeps["launchPersistentContext"] = () =>
      Promise.resolve(context as unknown as BrowserContext);

    await expect(
      LaunchBackend.create(
        {
          profile: "guest",
          profileDir: join(home, "profile"),
          executablePath: "/usr/bin/chromium",
          downloadDir: join(home, "downloads"),
        },
        {
          discoverBrowser: () =>
            Promise.resolve({ executablePath: "/usr/bin/chromium", browserName: "Chromium" }),
          launchPersistentContext,
          makeGuestProfileDir: () => Promise.resolve(join(home, "guest-session")),
          removeGuestProfileDir,
          verifyGuestProfile: () => Promise.resolve(false),
        },
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      hint: expect.stringMatching(/BROWSER_USE_PROFILE=default.*guest mode/i) as string,
    });
    expect(context.closed).toBe(true);
    expect(removeGuestProfileDir).toHaveBeenCalledWith(join(home, "guest-session"));
  });

  it("refuses a symlink at the persistent profile path before launching Chromium", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-profile-link-"));
    tempDirs.push(home);
    const target = join(home, "target");
    const profileDir = join(home, "profile");
    await mkdir(target);
    await symlink(target, profileDir);
    const launchPersistentContext = vi.fn<LaunchBackendDeps["launchPersistentContext"]>();

    await expect(
      LaunchBackend.create(
        {
          profile: "default",
          profileDir,
          executablePath: "/usr/bin/chromium",
          downloadDir: join(home, "downloads"),
        },
        {
          discoverBrowser: () =>
            Promise.resolve({ executablePath: "/usr/bin/chromium", browserName: "Chromium" }),
          launchPersistentContext,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(launchPersistentContext).not.toHaveBeenCalled();
  });

  it("reports local file access and exposes download changes", async () => {
    const { backend, context, home } = await createFixture();
    expect(await backend.isFileAccessAllowed()).toBe(true);

    const downloads: unknown[] = [];
    backend.onDownloadsChanged((items) => downloads.push(items));
    pageAt(context, 0).emit("download", {
      suggestedFilename: () => "report.txt",
      url: () => "https://example.com/report.txt",
      failure: () => Promise.resolve(null),
      path: () => Promise.resolve("/tmp/report.txt"),
      createReadStream: () => undefined,
      saveAs: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      page: () => pageAt(context, 0),
    });

    expect(downloads).toHaveLength(1);
    await vi.waitFor(() => {
      expect(backend.listDownloads()[0]?.filename).toBe(join(home, "downloads", "1-report.txt"));
    });
    await backend.close();
  });

  it("tracks a JavaScript dialog, reports it in tab state, and blocks other commands", async () => {
    const { backend, context } = await createFixture();
    const tabId = backend.listTabs()[0]?.tabId;
    if (tabId === undefined) throw new Error("Expected an attached tab");
    const session = context.sessions.get(pageAt(context, 0));
    if (!session) throw new Error("Expected the tab to have a CDP session");
    session.emit("event", {
      method: "Page.javascriptDialogOpening",
      params: {
        type: "alert",
        message: "hello from headless",
        url: "https://example.com/",
      },
    });

    expect(backend.listTabs()[0]?.pendingDialog).toMatchObject({
      type: "alert",
      message: "hello from headless",
    });
    await expect(
      backend.sendCommand(tabId, "Runtime.evaluate", { expression: "1" }, 1000),
    ).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    await backend.close();
  });

  it("keeps Playwright from auto-dismissing page dialogs", async () => {
    const { backend, context } = await createFixture();
    expect(pageAt(context, 0).listenerCount("dialog")).toBeGreaterThan(0);
    await backend.close();
  });

  it("closes the owned browser exactly once", async () => {
    const { backend, context } = await createFixture();
    await backend.close();
    await backend.close();
    expect(context.closed).toBe(true);
  });

  it("rejects a pending command when the launched browser exits", async () => {
    const { backend, context } = await createFixture();
    const tabId = backend.listTabs()[0]?.tabId;
    if (tabId === undefined) throw new Error("Expected an attached tab");
    const session = context.sessions.get(pageAt(context, 0));
    if (!session) throw new Error("Expected an attached page session");
    session.send = () => new Promise<never>(() => undefined);
    const pending = backend.sendCommand(tabId, "Runtime.evaluate", { expression: "1" }, 60_000);

    context.emit("close");

    await expect(pending).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
    await backend.close();
  });

  it("rejects pending commands when an individual tab closes", async () => {
    const { backend, context } = await createFixture();
    const tabId = backend.listTabs()[0]?.tabId;
    if (tabId === undefined) throw new Error("Expected an attached tab");
    const session = context.sessions.get(pageAt(context, 0));
    if (!session) throw new Error("Expected an attached page session");
    session.send = () => new Promise<never>(() => undefined);
    const pending = backend.sendCommand(tabId, "Runtime.evaluate", { expression: "1" }, 60_000);

    await backend.closeTab(tabId);

    await expect(pending).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
    await backend.close();
  });
});
