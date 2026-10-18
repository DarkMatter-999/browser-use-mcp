import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchBackend } from "../../src/daemon/launch-backend";
import {
  assertBuilt,
  chromeBin,
  cli,
  cliPath,
  type FixtureServer,
  freePort,
  poll,
  startFixtureServer,
  tempDir,
} from "./harness";

interface TextContent {
  type: string;
  text?: string;
}

interface ToolResult {
  isError: boolean;
  json: Record<string, unknown>;
  text: string;
}

const chromiumAvailable = existsSync(chromeBin);
if (!chromiumAvailable) {
  process.stderr.write(`Skipping launch-mode E2E: no Chromium at ${chromeBin} (set CHROME_BIN).\n`);
}

describe.skipIf(!chromiumAvailable)("headless launch mode", () => {
  let client: Client | undefined;
  let fixture: FixtureServer | undefined;
  let home = "";
  let env: NodeJS.ProcessEnv = process.env;
  let fixtureUrl = "";
  let tabId: number;

  function mcpClient(): Client {
    if (!client) throw new Error("MCP client is not connected");
    return client;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = (await mcpClient().callTool({ name, arguments: args })) as {
      content: TextContent[];
      isError?: boolean;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      // Text results such as the accessibility snapshot are not JSON objects.
    }
    return { isError: result.isError === true, json, text };
  }

  async function ok(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.text}`);
    return result;
  }

  async function evaluate(expression: string): Promise<unknown> {
    return (await ok("browser_evaluate", { tabId, expression })).json.value;
  }

  beforeAll(async () => {
    if (!chromiumAvailable)
      throw new Error(`Install Chromium or set CHROME_BIN (checked ${chromeBin}).`);
    assertBuilt();
    fixture = await startFixtureServer();
    fixtureUrl = `${fixture.origin}/index.html`;
    home = await tempDir("bu-launch-e2e-home-");
    env = {
      ...process.env,
      BROWSER_USE_HOME: home,
      BROWSER_USE_MODE: "headless",
      BROWSER_USE_PROFILE: "default",
      BROWSER_USE_CHROME_PATH: chromeBin,
      BROWSER_USE_POINTER: "0",
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: env as Record<string, string>,
      stderr: "inherit",
    });
    client = new Client({ name: "browser-use-headless-e2e", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // The daemon may already have been stopped by the persistence test.
    }
    try {
      await cli(["stop"], env);
    } catch {
      // The daemon may already be stopped.
    }
    await fixture?.close().catch(() => undefined);
    if (home.length > 0) await rm(home, { recursive: true, force: true });
  });

  it("runs existing MCP tools headlessly, including downloads and dialogs", async () => {
    const status = await ok("browser_status");
    expect(status.json).toMatchObject({
      mode: "headless",
      requestedMode: "headless",
      profile: "default",
      extensionConnected: false,
      browserName: expect.any(String) as string,
    });

    const opened = await ok("browser_open_tab", { url: fixtureUrl });
    tabId = opened.json.tabId as number;
    expect(await evaluate("document.title")).toBe("E2E fixture");
    expect((await ok("browser_snapshot", { tabId })).text).toContain("E2E fixture");

    await ok("browser_click", { tabId, selector: "#increment" });
    expect(await evaluate("document.getElementById('count').textContent")).toBe("1");

    const clicked = await ok("browser_click", { tabId, selector: "#alert" });
    expect(clicked.json.dialog, clicked.text).toMatchObject({ type: "alert" });
    await ok("browser_handle_dialog", { tabId, accept: true });

    await ok("browser_click", { tabId, selector: "#download" });
    const waited = await ok("browser_wait", { tabId, condition: "download" });
    const download = waited.json.download as {
      downloadId: number;
      state: string;
      filename: string;
    };
    expect(download.state).toBe("complete");
    expect(await readFile(download.filename, "utf8")).toContain("download body");
    const downloads = await ok("browser_downloads");
    expect(downloads.json.downloads).toEqual(
      expect.arrayContaining([expect.objectContaining({ downloadId: download.downloadId })]),
    );
  });

  it("retains the dedicated profile across daemon shutdown and restart", async () => {
    await evaluate("localStorage.setItem('browser-use-persisted', 'retained')");
    await cli(["stop"], env);
    await poll(
      async () => {
        const status = JSON.parse(await cli(["status", "--json"], env)) as { running?: boolean };
        return status.running === false ? true : undefined;
      },
      { what: "the headless daemon to stop" },
    );

    const status = await ok("browser_status");
    expect(status.json).toMatchObject({ mode: "headless", profile: "default" });
    const opened = await ok("browser_open_tab", { url: fixtureUrl });
    tabId = opened.json.tabId as number;
    expect(await evaluate("localStorage.getItem('browser-use-persisted')")).toBe("retained");
  });

  it("falls back from auto to headless when no extension is available at startup", async () => {
    const autoHome = await tempDir("bu-auto-e2e-home-");
    const autoEnv = {
      ...env,
      BROWSER_USE_HOME: autoHome,
      BROWSER_USE_MODE: "auto",
      BROWSER_USE_PORT: String(await freePort()),
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: autoEnv,
      stderr: "inherit",
    });
    const autoClient = new Client({ name: "browser-use-auto-e2e", version: "1.0.0" });
    try {
      await autoClient.connect(transport);
      const result = (await autoClient.callTool({ name: "browser_status", arguments: {} })) as {
        content: TextContent[];
        isError?: boolean;
      };
      const statusText = result.content.find((item) => item.type === "text")?.text ?? "";
      expect(result.isError).not.toBe(true);
      const parsedStatus: unknown = JSON.parse(statusText);
      expect(parsedStatus).toMatchObject({
        mode: "headless",
        requestedMode: "auto",
        fallbackReason: expect.stringMatching(/extension unavailable at startup/i) as string,
      });
    } finally {
      await autoClient.close().catch(() => undefined);
      await cli(["stop"], autoEnv).catch(() => undefined);
      await rm(autoHome, { recursive: true, force: true });
    }
  });

  it("cleans a disposable guest profile or reports guest mode unsupported", async () => {
    const guestHome = await tempDir("bu-guest-e2e-home-");
    let guestBackend: LaunchBackend | undefined;
    try {
      try {
        guestBackend = await LaunchBackend.create({
          profile: "guest",
          profileDir: join(guestHome, "profile"),
          executablePath: chromeBin,
          downloadDir: join(guestHome, "downloads"),
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "UNSUPPORTED_CAPABILITY",
          hint: expect.stringMatching(/supports guest mode/i) as string,
        });
        return;
      }

      expect((await readdir(guestHome)).some((name) => name.startsWith("guest-"))).toBe(true);
      await guestBackend.close();
      guestBackend = undefined;
      expect((await readdir(guestHome)).some((name) => name.startsWith("guest-"))).toBe(false);
    } finally {
      await guestBackend?.close();
      await rm(guestHome, { recursive: true, force: true });
    }
  });
});
