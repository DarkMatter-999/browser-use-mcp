import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
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
  freePort,
  launchBrowser,
  poll,
  popupSend,
  setExtensionStorage,
  startFixtureServer,
  tempDir,
  type FixtureServer,
  type LaunchedBrowser,
} from "./harness";

interface TextContent {
  type: string;
  text?: string;
}

interface ToolResponse {
  isError?: boolean;
  content: TextContent[];
}

interface ErrorResponse {
  error: { code: string };
}

const chromiumAvailable = existsSync(chromeBin);
if (!chromiumAvailable) {
  process.stderr.write(
    `Skipping auto-selection E2E: no Chromium at ${chromeBin} (set CHROME_BIN).\n`,
  );
}

describe.skipIf(!chromiumAvailable)("automatic backend selection", () => {
  let home: string;
  let port: number;
  let env: NodeJS.ProcessEnv | undefined;
  let autoEnv: NodeJS.ProcessEnv | undefined;
  let fixture: FixtureServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let popup: Page | undefined;
  let extensionClient: Client | undefined;
  let autoClient: Client | undefined;
  let fixtureUrl: string;

  function configuredEnv(): NodeJS.ProcessEnv {
    if (!env) throw new Error("E2E environment is not initialized");
    return env;
  }

  function activePopup(): Page {
    if (!popup) throw new Error("Extension popup is not initialized");
    return popup;
  }

  function extensionMcpClient(): Client {
    if (!extensionClient) throw new Error("Extension MCP client is not connected");
    return extensionClient;
  }

  function autoMcpClient(): Client {
    if (!autoClient) throw new Error("Auto-mode MCP client is not connected");
    return autoClient;
  }

  async function connectClient(clientEnv: NodeJS.ProcessEnv, name: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: clientEnv as Record<string, string>,
      stderr: "inherit",
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
    return (await client.callTool({ name, arguments: args })) as ToolResponse;
  }

  beforeAll(async () => {
    if (!chromiumAvailable)
      throw new Error(`Install Chromium or set CHROME_BIN (checked ${chromeBin}).`);
    assertBuilt();
    home = await tempDir("bu-auto-extension-e2e-");
    port = await freePort();
    fixture = await startFixtureServer();
    fixtureUrl = `${fixture.origin}/index.html`;
    env = {
      ...process.env,
      BROWSER_USE_HOME: home,
      BROWSER_USE_MODE: "extension",
      BROWSER_USE_PROFILE: "default",
      BROWSER_USE_PORT: String(port),
    };
    browser = await launchBrowser({ extensionDir, chromeBin });
    extensionClient = await connectClient(configuredEnv(), "browser-use-extension-e2e");

    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(await cli(["pair"], configuredEnv()))?.[1];
    if (!code) throw new Error("The daemon did not return an extension pairing code");
    popup = await extensionPage(browser.context, EXTENSION_ID);
    await setExtensionStorage(activePopup(), { port });
    const pairing = (await popupSend(activePopup(), { type: "pair", code })) as {
      error?: string;
    };
    expect(pairing.error).toBeUndefined();

    const page = await browser.context.newPage();
    await page.goto(fixtureUrl);
    await page.bringToFront();
    const connection = (await popupSend(activePopup(), { type: "connect-active-tab" })) as {
      error?: string;
    };
    expect(connection.error).toBeUndefined();
    await poll(
      async () => {
        const status = await tool(extensionMcpClient(), "browser_status");
        const text = status.content.find((item) => item.type === "text")?.text ?? "";
        const value = JSON.parse(text) as { extensionConnected?: boolean };
        return value.extensionConnected ? true : undefined;
      },
      { what: "the extension backend to connect" },
    );
  });

  afterAll(async () => {
    await autoClient?.close().catch(() => undefined);
    await extensionClient?.close().catch(() => undefined);
    if (autoEnv) await cli(["stop"], autoEnv).catch(() => undefined);
    if (env) await cli(["stop"], env).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("selects a ready extension in auto mode and never switches after disconnect", async () => {
    await extensionMcpClient().close();
    extensionClient = undefined;
    await cli(["stop"], configuredEnv());
    await poll(
      async () => {
        const status = JSON.parse(await cli(["status", "--json"], configuredEnv())) as {
          running?: boolean;
        };
        return status.running === false ? true : undefined;
      },
      { what: "the extension-mode daemon to stop" },
    );

    autoEnv = { ...configuredEnv(), BROWSER_USE_MODE: "auto" };
    autoClient = await connectClient(autoEnv, "browser-use-auto-extension-e2e");
    const selected = await tool(autoMcpClient(), "browser_status");
    const selectedText = selected.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(selectedText)).toMatchObject({
      mode: "extension",
      requestedMode: "auto",
      extensionConnected: true,
    });

    await popupSend(activePopup(), { type: "disconnect-all" });
    await poll(
      async () => {
        const disconnected = await tool(autoMcpClient(), "browser_status");
        const text = disconnected.content.find((item) => item.type === "text")?.text ?? "";
        const value = JSON.parse(text) as { extensionConnected?: boolean };
        return value.extensionConnected === false ? true : undefined;
      },
      { what: "the extension to disconnect after its last tab detaches" },
    );

    const opened = await tool(autoMcpClient(), "browser_open_tab", { url: fixtureUrl });
    expect(opened.isError).toBe(true);
    const text = opened.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(text) as ErrorResponse).toMatchObject({
      error: { code: "BRIDGE_DISCONNECTED" },
    });
    const stillExtension = await tool(autoMcpClient(), "browser_status");
    const stillExtensionText =
      stillExtension.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(stillExtensionText)).toMatchObject({
      mode: "extension",
      requestedMode: "auto",
    });
  });
});
