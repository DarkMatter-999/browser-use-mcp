import { BrowserUseError, navigableUrl } from "@browser-use/protocol";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { tabIdField } from "./schema";

export const tabTools = [
  defineTool({
    name: "browser_status",
    title: "Browser status",
    description:
      "Report daemon and extension status: pairing, connection, controlled tabs and whether the visual pointer is enabled.",
    inputShape: {},
    handler: async (ctx) => {
      const status = await ctx.status();
      return jsonResult({ ...status, pointer: ctx.pointer.enabled });
    },
  }),
  defineTool({
    name: "browser_tabs",
    title: "List tabs",
    description:
      "List the tabs Browser Use controls, with id, url, title and any pending JavaScript dialog.",
    inputShape: {},
    // Ask the daemon rather than the cached list: the request reconnects (and autostarts the
    // daemon) if it went away, so the answer reflects the current daemon, not a dead one.
    handler: async (ctx) => jsonResult((await ctx.status()).tabs),
  }),
  defineTool({
    name: "browser_open_tab",
    title: "Open tab",
    description:
      'Open a URL in a new background tab. The tab is connected automatically and grouped under "Browser Use".',
    inputShape: { url: navigableUrl.describe("http(s) URL or about:blank") },
    handler: async (ctx, { url }) =>
      jsonResult({ tabId: await ctx.openTab(url), connected: true, autoConnected: true }),
  }),
  defineTool({
    name: "browser_close_tab",
    title: "Close tab",
    description: "Close a tab controlled by Browser Use.",
    inputShape: { tabId: tabIdField.describe("Tab id from browser_tabs") },
    handler: async (ctx, { tabId }) => {
      if (!ctx.listTabs().some((tab) => tab.tabId === tabId)) {
        throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`, {
          hint: "Call browser_tabs to see the tabs you control.",
        });
      }
      await ctx.closeTab(tabId);
      return jsonResult({ tabId, closed: true });
    },
  }),
];
