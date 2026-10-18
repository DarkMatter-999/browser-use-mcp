import { describe, expect, it, vi } from "vitest";
import { tabTools } from "../src/tools/tabs";
import { makeContext } from "./helpers/context";

const tool = (name: string) => {
  const found = tabTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const parse = (output: { content: { type: string; text?: string }[] }) =>
  JSON.parse(output.content[0]?.text ?? "") as unknown;

describe("tab tools", () => {
  it("registers the four tab tools", () => {
    expect(tabTools.map((t) => t.name)).toEqual([
      "browser_status",
      "browser_tabs",
      "browser_open_tab",
      "browser_close_tab",
    ]);
  });

  it("browser_status returns the daemon status and the pointer flag", async () => {
    const status = {
      daemonVersion: "1",
      pid: 1,
      port: 38241,
      paired: true,
      extensionConnected: true,
      tabs: [],
      mode: "extension" as const,
      requestedMode: "extension" as const,
      profile: "default" as const,
      capabilities: { cdp: true, downloads: true, dialogs: true, fileAccess: true, pointer: true },
    };
    const ctx = makeContext({ status: () => Promise.resolve(status) });
    expect(parse(await tool("browser_status").run(ctx, {}))).toMatchObject({
      extensionConnected: true,
      mode: "extension",
      pointer: false,
    });
  });

  it("browser_tabs lists tabs including a pending dialog", async () => {
    const tabs = [
      {
        tabId: 3,
        url: "https://a/",
        title: "A",
        pendingDialog: { type: "alert" as const, message: "hi", url: "https://a/" },
      },
    ];
    const ctx = makeContext({
      listTabs: () => [],
      status: () =>
        Promise.resolve({
          daemonVersion: "1",
          pid: 1,
          port: 38241,
          paired: true,
          extensionConnected: true,
          tabs,
          mode: "extension" as const,
          requestedMode: "extension" as const,
          profile: "default" as const,
          capabilities: {
            cdp: true,
            downloads: true,
            dialogs: true,
            fileAccess: true,
            pointer: true,
          },
        }),
    });
    // The daemon's answer wins over the (possibly stale) cached list.
    expect(parse(await tool("browser_tabs").run(ctx, {}))).toEqual(tabs);
  });

  it("browser_open_tab opens a background tab that is already connected", async () => {
    const openTab = vi.fn(() => Promise.resolve(12));
    const ctx = makeContext({ openTab });
    expect(parse(await tool("browser_open_tab").run(ctx, { url: "https://example.com/" }))).toEqual(
      { tabId: 12, connected: true, autoConnected: true },
    );
    expect(openTab).toHaveBeenCalledWith("https://example.com/");
  });

  it("browser_open_tab rejects non-http(s) URLs", async () => {
    const out = await tool("browser_open_tab").run(makeContext(), { url: "javascript:alert(1)" });
    expect(out.isError).toBe(true);
  });

  it("browser_close_tab only closes controlled tabs", async () => {
    const closeTab = vi.fn(() => Promise.resolve());
    const ctx = makeContext({
      listTabs: () => [{ tabId: 5, url: "https://a/", title: "A" }],
      closeTab,
    });
    const refused = await tool("browser_close_tab").run(ctx, { tabId: 6 });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ error: { code: "TAB_NOT_CONNECTED" } });
    expect(closeTab).not.toHaveBeenCalled();
    expect(parse(await tool("browser_close_tab").run(ctx, { tabId: 5 }))).toEqual({
      tabId: 5,
      closed: true,
    });
  });
});
