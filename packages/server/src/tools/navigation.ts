import { BrowserUseError, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const NAVIGATION_LOAD_TIMEOUT_MS = 60_000;

export const navigationUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:" || protocol === "file:";
}, "Only http, https and file URLs are supported");

const tabShape = { tabId: tabIdField.describe("Tab id from browser_tabs") };
const navigateShape = { ...tabShape, url: navigationUrlSchema };
const navigateSchema = z.object(navigateShape);

export async function navigate(
  ctx: ToolContext,
  input: z.input<typeof navigateSchema>,
): Promise<JsonValue> {
  const args = navigateSchema.parse(input);
  requireTab(ctx, args.tabId);
  if (new URL(args.url).protocol === "file:" && !(await ctx.isFileAccessAllowed())) {
    throw new BrowserUseError("INVALID_ARGUMENT", "file: URLs are not enabled for the extension", {
      hint: "Enable 'Allow access to file URLs' for the Browser Use extension in chrome://extensions.",
    });
  }
  await ctx.sendCommand(args.tabId, "Page.enable", {});
  await ctx.sendCommand(args.tabId, "Page.setLifecycleEventsEnabled", { enabled: true });

  let loaderId: string | undefined;
  const loadedLoaders = new Set<string>();
  let resolveLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });
  const unsubscribe = ctx.subscribe(args.tabId, (method, params) => {
    if (
      method === "Page.lifecycleEvent" &&
      params.name === "load" &&
      typeof params.loaderId === "string"
    ) {
      loadedLoaders.add(params.loaderId);
      if (params.loaderId === loaderId) resolveLoaded();
    }
  });
  const unsubscribeRemoval = ctx.onTabRemoved((removedTabId) => {
    if (removedTabId === args.tabId) {
      resolveLoaded();
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await ctx.sendCommand(args.tabId, "Page.navigate", { url: args.url }, 15_000);
    const info = asObject(result);
    if (typeof info.errorText === "string") {
      throw new BrowserUseError("NAVIGATION_FAILED", info.errorText);
    }
    loaderId = typeof info.loaderId === "string" ? info.loaderId : undefined;
    if (!loaderId) return result;
    if (!loadedLoaders.has(loaderId)) {
      await Promise.race([
        loaded,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new BrowserUseError("TIMEOUT", "Timed out waiting for page load", {
                hint: "The navigation may still be in progress; use browser_wait or browser_stop.",
              }),
            );
          }, NAVIGATION_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (!ctx.listTabs().some((tab) => tab.tabId === args.tabId)) {
        throw new BrowserUseError(
          "TAB_NOT_CONNECTED",
          `Tab ${args.tabId} detached while navigating`,
        );
      }
    }
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    unsubscribeRemoval();
  }
}

export async function reload(ctx: ToolContext, input: { tabId: number }): Promise<JsonValue> {
  requireTab(ctx, input.tabId);
  return ctx.sendCommand(input.tabId, "Page.reload", { ignoreCache: false });
}

export async function history(
  ctx: ToolContext,
  input: { tabId: number },
  direction: "back" | "forward",
): Promise<JsonValue> {
  requireTab(ctx, input.tabId);
  const result = asObject(await ctx.sendCommand(input.tabId, "Page.getNavigationHistory", {}));
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const currentIndex = typeof result.currentIndex === "number" ? result.currentIndex : -1;
  const target = asObject(entries[currentIndex + (direction === "back" ? -1 : 1)]);
  if (typeof target.id !== "number" || !Number.isInteger(target.id)) {
    return {
      navigated: false,
      reason: direction === "back" ? "NO_BACK_HISTORY" : "NO_FORWARD_HISTORY",
    };
  }
  await ctx.sendCommand(input.tabId, "Page.navigateToHistoryEntry", { entryId: target.id });
  return { navigated: true, entryId: target.id };
}

export async function stop(ctx: ToolContext, input: { tabId: number }): Promise<JsonValue> {
  requireTab(ctx, input.tabId);
  await ctx.sendCommand(input.tabId, "Page.stopLoading", {});
  return { stopped: true };
}

export const navigationTools = [
  defineTool({
    name: "browser_navigate",
    title: "Navigate",
    description:
      "Navigate a connected tab to an http(s) or file: URL and wait for the load event (up to 60 s). file: URLs need 'Allow access to file URLs' enabled for the extension.",
    inputShape: navigateShape,
    handler: async (ctx, args) => jsonResult(await navigate(ctx, args)),
  }),
  defineTool({
    name: "browser_reload",
    title: "Reload",
    description: "Reload a connected tab.",
    inputShape: tabShape,
    handler: async (ctx, args) => jsonResult(await reload(ctx, args)),
  }),
  defineTool({
    name: "browser_back",
    title: "Back",
    description: "Navigate a connected tab to its previous history entry.",
    inputShape: tabShape,
    handler: async (ctx, args) => jsonResult(await history(ctx, args, "back")),
  }),
  defineTool({
    name: "browser_forward",
    title: "Forward",
    description: "Navigate a connected tab to its next history entry.",
    inputShape: tabShape,
    handler: async (ctx, args) => jsonResult(await history(ctx, args, "forward")),
  }),
  defineTool({
    name: "browser_stop",
    title: "Stop loading",
    description: "Stop loading the connected tab.",
    inputShape: tabShape,
    handler: async (ctx, args) => jsonResult(await stop(ctx, args)),
  }),
];
