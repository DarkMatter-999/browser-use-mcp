import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXTENSION_ID } from "@browser-use/protocol";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertBuilt,
  chromeBin,
  cli,
  cliPath,
  extensionDir,
  extensionPage,
  type FixtureServer,
  freePort,
  type LaunchedBrowser,
  launchBrowser,
  poll,
  popupSend,
  setExtensionStorage,
  startFixtureServer,
  tempDir,
} from "./harness";

// The 38 tools reported by Task 20 (test/registry.test.ts).
const EXPECTED_TOOLS = [
  "browser_status",
  "browser_tabs",
  "browser_open_tab",
  "browser_close_tab",
  "browser_evaluate",
  "browser_navigate",
  "browser_reload",
  "browser_back",
  "browser_forward",
  "browser_stop",
  "browser_wait",
  "browser_dom_snapshot",
  "browser_accessibility_snapshot",
  "browser_query",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_select",
  "browser_hover",
  "browser_focus",
  "browser_scroll",
  "browser_press_key",
  "browser_drag",
  "browser_handle_dialog",
  "browser_console",
  "browser_network",
  "browser_clear_diagnostics",
  "browser_cookies",
  "browser_storage",
  "browser_emulate",
  "browser_reset_emulation",
  "browser_performance",
  "browser_trace",
  "browser_pdf",
  "browser_snapshot",
  "browser_upload",
  "browser_downloads",
];

const PAIRING_CODE = /([A-Z2-9]{4}-[A-Z2-9]{4})/;
const chromeAvailable = existsSync(chromeBin);
if (!chromeAvailable) {
  process.stderr.write(`Skipping E2E: no Chromium at ${chromeBin} (set CHROME_BIN to override).\n`);
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface CallResult {
  isError: boolean;
  json: Record<string, unknown>;
  text: string;
  content: ContentItem[];
}

interface ErrorJson {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

interface OverlayGlobal {
  __browserUseOverlay: { hide(): void; show(): void };
}

interface TabJson {
  tabId: number;
  url: string;
  title: string;
  pendingDialog?: { type: string; message: string };
}

const suiteName = chromeAvailable
  ? "browser use end to end"
  : `browser use end to end (skipped: no Chromium at ${chromeBin}; set CHROME_BIN)`;

describe.skipIf(!chromeAvailable)(suiteName, () => {
  let fixture: FixtureServer;
  let home: string;
  let browser: LaunchedBrowser;
  let client: Client;
  let popup: Page;
  let fixturePage: Page;
  let env: NodeJS.ProcessEnv;
  let fixtureUrl: string;
  let tabId: number;
  let uploadDir: string | undefined;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: ContentItem[];
      isError?: boolean;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      /* plain-text result such as browser_snapshot */
    }
    return { isError: result.isError === true, json, text, content: result.content };
  }

  async function ok(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.text}`);
    return result;
  }

  async function evaluate(expression: string, onTab = tabId): Promise<unknown> {
    return (await ok("browser_evaluate", { tabId: onTab, expression })).json.value;
  }

  async function tabs(): Promise<TabJson[]> {
    const result = await ok("browser_tabs");
    return JSON.parse(result.text) as TabJson[];
  }

  async function snapshotRef(label: RegExp): Promise<string> {
    const { text } = await ok("browser_snapshot", { tabId });
    const ref = label.exec(text)?.[1];
    if (ref === undefined) throw new Error(`No ref for ${String(label)} in snapshot:\n${text}`);
    return ref;
  }

  beforeAll(async () => {
    assertBuilt();
    fixture = await startFixtureServer();
    fixtureUrl = `${fixture.origin}/index.html`;
    home = await tempDir("bu-e2e-home-");
    const port = await freePort();
    env = { ...process.env, BROWSER_USE_HOME: home, BROWSER_USE_PORT: String(port) };
    browser = await launchBrowser({ extensionDir, chromeBin });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: env as Record<string, string>,
      stderr: "inherit",
    });
    client = new Client({ name: "browser-use-e2e", version: "1.0.0" });
    await client.connect(transport);

    const code = PAIRING_CODE.exec(await cli(["pair"], env))?.[1];
    expect(code).toBeDefined();

    popup = await extensionPage(browser.context, EXTENSION_ID);
    await setExtensionStorage(popup, { port });
    const paired = (await popupSend(popup, { type: "pair", code })) as { error?: string };
    expect(paired.error).toBeUndefined();

    fixturePage = await browser.context.newPage();
    await fixturePage.goto(fixtureUrl);
    await fixturePage.bringToFront();
    const connected = (await popupSend(popup, { type: "connect-active-tab" })) as {
      error?: string;
    };
    expect(connected.error).toBeUndefined();
    const listed = await poll(async () => (await tabs()).find((tab) => tab.url === fixtureUrl), {
      what: "the fixture tab in browser_tabs",
    });
    tabId = listed.tabId;
  });

  afterAll(async () => {
    // Each step runs even if an earlier one (or beforeAll) failed, so nothing is left behind.
    const steps: (() => Promise<unknown>)[] = [
      () => client.close(),
      () => cli(["stop"], env),
      () => browser.close(),
      () => fixture.close(),
      () => rm(home, { recursive: true, force: true }),
      () => (uploadDir === undefined ? Promise.resolve() : rm(uploadDir, { recursive: true })),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("identity and tools", async () => {
    const worker =
      browser.context.serviceWorkers()[0] ??
      (await browser.context.waitForEvent("serviceworker", { timeout: 15_000 }));
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    const status = await ok("browser_status");
    expect(status.json).toMatchObject({ extensionConnected: true, mode: "extension" });
  });

  it("snapshot and refs", async () => {
    const { text } = await ok("browser_snapshot", { tabId });
    expect(text).toMatch(/button "Increment" \[ref=e\d+\]/);
    expect(text).toContain('button "Inside frame"');
    const ref = await snapshotRef(/button "Increment" \[ref=(e\d+)\]/);
    const byRef = await ok("browser_click", { tabId, ref });
    expect(byRef.json.page).toMatchObject({ url: fixtureUrl });
    expect(await evaluate("document.getElementById('count').textContent")).toBe("1");
    const bySelector = await ok("browser_click", { tabId, selector: "#increment" });
    expect(bySelector.json.page).toMatchObject({ url: fixtureUrl });
    expect(await evaluate("document.getElementById('count').textContent")).toBe("2");
  });

  it("stale refs", async () => {
    const ref = await snapshotRef(/button "Increment" \[ref=(e\d+)\]/);
    await ok("browser_navigate", { tabId, url: `${fixture.origin}/next.html` });
    const stale = await call("browser_click", { tabId, ref });
    expect(stale.isError).toBe(true);
    expect((stale.json as unknown as ErrorJson).error.code).toBe("STALE_REF");
    await ok("browser_navigate", { tabId, url: fixtureUrl });
    await snapshotRef(/button "Increment" \[ref=(e\d+)\]/);
  });

  it("fill and select", async () => {
    const ref = await snapshotRef(/textbox "Email" \[ref=(e\d+)\]/);
    await ok("browser_fill", { tabId, ref, value: "agent@example.com" });
    expect(await evaluate("document.getElementById('email').value")).toBe("agent@example.com");
    await ok("browser_select", { tabId, selector: "#color", value: "blue" });
    expect(await evaluate("document.getElementById('color').value")).toBe("blue");
  });

  it("agent-opened tab", async () => {
    const opened = await ok("browser_open_tab", { url: fixtureUrl });
    expect(opened.json.autoConnected).toBe(true);
    const newTab = opened.json.tabId as number;
    expect(await evaluate("document.title", newTab)).toBe("E2E fixture");
    await ok("browser_close_tab", { tabId: newTab });
    await poll(
      async () => ((await tabs()).some((tab) => tab.tabId === newTab) ? undefined : true),
      {
        what: "the agent tab to disappear",
      },
    );
  });

  it("JavaScript dialog", async () => {
    const clicked = await ok("browser_click", { tabId, selector: "#alert" });
    expect(clicked.json.dialog).toMatchObject({ type: "alert" });
    const listed = (await tabs()).find((tab) => tab.tabId === tabId);
    expect(listed?.pendingDialog).toMatchObject({ type: "alert", message: "hello from the page" });
    const blocked = await call("browser_evaluate", { tabId, expression: "1" });
    expect(blocked.isError).toBe(true);
    const { error } = blocked.json as unknown as ErrorJson;
    expect(error.code).toBe("DIALOG_OPEN");
    expect(error.hint).toBeTruthy();
    await ok("browser_handle_dialog", { tabId, accept: true });
    expect(await evaluate("1 + 1")).toBe(2);
  });

  it("beforeunload", async () => {
    await ok("browser_click", { tabId, selector: "#arm" });
    const next = `${fixture.origin}/next.html`;
    const navigation = await call("browser_navigate", { tabId, url: next });
    expect(navigation.isError).toBe(true);
    const { error } = navigation.json as unknown as ErrorJson;
    expect(error.code).toBe("DIALOG_OPEN");
    expect(error.details).toMatchObject({ type: "beforeunload" });
    await ok("browser_handle_dialog", { tabId, accept: true });
    await poll(
      async () => (await tabs()).find((tab) => tab.tabId === tabId)?.url === next || undefined,
      { what: "the tab to reach next.html" },
    );
  });

  it("upload", async () => {
    uploadDir = await tempDir("bu-e2e-upload-");
    const uploadFile = join(uploadDir, "upload-me.txt");
    await writeFile(uploadFile, "upload body");
    await ok("browser_navigate", { tabId, url: fixtureUrl });
    await ok("browser_upload", { tabId, selector: "#file", paths: [uploadFile] });
    expect(await evaluate("document.getElementById('file').files[0].name")).toBe("upload-me.txt");
    const clicked = await ok("browser_click", { tabId, selector: "#picker" });
    expect(clicked.json.fileChooser).toMatchObject({ open: true });
    await ok("browser_upload", { tabId, paths: [uploadFile] });
    expect(await evaluate("document.getElementById('file2').files[0]?.name")).toBe("upload-me.txt");
  });

  it("download", async () => {
    await ok("browser_click", { tabId, selector: "#download" });
    const waited = await ok("browser_wait", { tabId, condition: "download" });
    const download = waited.json.download as {
      downloadId: number;
      state: string;
      filename: string;
    };
    expect(download.state).toBe("complete");
    expect(existsSync(download.filename)).toBe(true);
    expect(await readFile(download.filename, "utf8")).toContain("download body");
    const listed = await ok("browser_downloads");
    const all = listed.json.downloads as { downloadId: number }[];
    expect(all.some((entry) => entry.downloadId === download.downloadId)).toBe(true);
    // Playwright's acceptDownloads saves under a GUID name; outside Playwright Chrome reports
    // ~/Downloads/report.txt (checked manually, see the Task 22 report).
  });

  it("pointer overlay", async () => {
    const clicked = await ok("browser_click", { tabId, selector: "#increment" });
    expect(await evaluate("Boolean(document.querySelector('[data-browser-use-overlay]'))")).toBe(
      true,
    );
    expect(
      await evaluate(
        "document.querySelector('[data-browser-use-overlay]').matches(':popover-open')",
      ),
    ).toBe(true);
    const box = (await evaluate(
      "(() => { const r = document.querySelector('[data-browser-use-overlay]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()",
    )) as { width: number; height: number };
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const { text } = await ok("browser_snapshot", { tabId });
    expect(text.toLowerCase()).not.toContain("overlay");
    // Visual check: the region around the click point renders differently with the overlay
    // shown (cursor + label) than with it hidden.
    const { x, y } = clicked.json as { x: number; y: number };
    const clip = { x: Math.max(0, x - 4), y: Math.max(0, y - 4), width: 48, height: 48 };
    await fixturePage.evaluate(() => {
      (globalThis as unknown as OverlayGlobal).__browserUseOverlay.hide();
    });
    const hidden = await fixturePage.screenshot({ clip });
    await fixturePage.evaluate(() => {
      (globalThis as unknown as OverlayGlobal).__browserUseOverlay.show();
    });
    await poll(
      async () => ((await fixturePage.screenshot({ clip })).equals(hidden) ? undefined : true),
      {
        what: "the overlay cursor to render",
      },
    );
    const shot = await ok("browser_screenshot", { tabId });
    expect(shot.content.some((item) => item.type === "image" && item.data)).toBe(true);
    // The capture hides the overlay only for its duration.
    expect(
      await evaluate(
        "getComputedStyle(document.querySelector('[data-browser-use-overlay]')).visibility",
      ),
    ).toBe("visible");
  });

  it("cross-origin iframe", async () => {
    await ok("browser_navigate", { tabId, url: `${fixture.origin}/cross.html` });
    const { text } = await ok("browser_snapshot", { tabId });
    expect(text).toContain('button "Outside frame"');
    // Pins the known limitation: an out-of-process (cross-site) iframe is not reachable through
    // chrome.debugger's tab session, so its content is absent (documented on browser_snapshot).
    // Flip this when OOPIF support lands.
    expect(text).not.toContain("Inside frame");
    await ok("browser_navigate", { tabId, url: fixtureUrl });
  });

  it("daemon restart and reconnect", async () => {
    await cli(["stop"], env);
    await poll(
      async () => ((await tabs()).some((tab) => tab.url === fixtureUrl) ? true : undefined),
      { timeoutMs: 30_000, intervalMs: 500, what: "the fixture tab after a daemon restart" },
    );
    expect(await evaluate("1 + 1")).toBe(2);
  });

  it("disconnect", async () => {
    await popupSend(popup, { type: "disconnect-all" });
    await poll(async () => ((await tabs()).length === 0 ? true : undefined), {
      what: "browser_tabs to become empty",
    });
    const gone = await call("browser_evaluate", { tabId, expression: "1" });
    expect(gone.isError).toBe(true);
    expect((gone.json as unknown as ErrorJson).error.code).toBe("TAB_NOT_CONNECTED");
  });
});
