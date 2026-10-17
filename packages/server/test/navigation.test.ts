import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import {
  history,
  navigate,
  navigationTools,
  navigationUrlSchema,
  reload,
  stop,
} from "../src/tools/navigation";
import { scriptedContext } from "./helpers/context";
import { findTool, parseText } from "./helpers/tool";

const tab = [{ tabId: 1, url: "https://a/", title: "A" }];
const base = {
  "Page.enable": () => ({}),
  "Page.setLifecycleEventsEnabled": () => ({}),
};

describe("navigation", () => {
  it("accepts http(s) and file URLs only", () => {
    expect(navigationUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(navigationUrlSchema.safeParse("file:///tmp/page.html").success).toBe(true);
    expect(navigationUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("dispatches Page.navigate with a 15 s command timeout", async () => {
    const ctx = scriptedContext({ ...base, "Page.navigate": () => ({ frameId: "f" }) }, tab);
    await expect(navigate(ctx, { tabId: 1, url: "https://example.com/" })).resolves.toMatchObject({
      frameId: "f",
    });
    expect(ctx.calls.at(-1)).toMatchObject({
      method: "Page.navigate",
      params: { url: "https://example.com/" },
    });
  });

  it("maps errorText to NAVIGATION_FAILED", async () => {
    const ctx = scriptedContext(
      { ...base, "Page.navigate": () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }) },
      tab,
    );
    await expect(navigate(ctx, { tabId: 1, url: "https://nope.invalid/" })).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });

  it("waits for the matching load event before completing", async () => {
    const ctx = scriptedContext(
      { ...base, "Page.navigate": () => ({ frameId: "f", loaderId: "loader-1" }) },
      tab,
    );
    let completed = false;
    const pending = navigate(ctx, { tabId: 1, url: "https://example.com/" }).then((r) => {
      completed = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.emit(1, "Page.lifecycleEvent", { name: "load", loaderId: "previous" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    ctx.emit(1, "Page.lifecycleEvent", { name: "load", loaderId: "loader-1" });
    await expect(pending).resolves.toMatchObject({ loaderId: "loader-1" });
  });

  it("fails when the tab is removed mid-navigation", async () => {
    const ctx = scriptedContext(
      { ...base, "Page.navigate": () => ({ frameId: "f", loaderId: "loader-1" }) },
      tab,
    );
    const pending = navigate(ctx, { tabId: 1, url: "https://example.com/" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.removeTab(1);
    await expect(pending).rejects.toMatchObject({ code: "TAB_NOT_CONNECTED" });
  });

  it("propagates DIALOG_OPEN from a navigation blocked by beforeunload", async () => {
    const ctx = scriptedContext(
      {
        ...base,
        "Page.navigate": () => {
          throw new BrowserUseError("DIALOG_OPEN", "A beforeunload dialog is open", {
            details: { type: "beforeunload" },
          });
        },
      },
      tab,
    );
    await expect(navigate(ctx, { tabId: 1, url: "https://example.com/" })).rejects.toMatchObject({
      code: "DIALOG_OPEN",
      details: { type: "beforeunload" },
    });
  });

  it("rejects file: URLs unless file access is enabled for the extension", async () => {
    const ctx = scriptedContext({}, tab);
    ctx.isFileAccessAllowed = () => Promise.resolve(false);
    await expect(navigate(ctx, { tabId: 1, url: "file:///tmp/x.html" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      hint: expect.stringContaining("Allow access to file URLs") as string,
    });
  });

  it("allows file: URLs when file access is enabled", async () => {
    const ctx = scriptedContext({ ...base, "Page.navigate": () => ({ frameId: "f" }) }, tab);
    ctx.isFileAccessAllowed = () => Promise.resolve(true);
    await expect(navigate(ctx, { tabId: 1, url: "file:///tmp/x.html" })).resolves.toBeDefined();
  });

  it("reloads, stops and traverses only available history entries", async () => {
    const ctx = scriptedContext(
      {
        "Page.reload": () => ({}),
        "Page.stopLoading": () => ({}),
        "Page.navigateToHistoryEntry": () => ({}),
        "Page.getNavigationHistory": () => ({
          entries: [{ id: 2 }, { id: 3 }, { id: 4 }],
          currentIndex: 1,
        }),
      },
      tab,
    );
    await reload(ctx, { tabId: 1 });
    expect(ctx.calls.at(-1)).toMatchObject({
      method: "Page.reload",
      params: { ignoreCache: false },
    });
    await expect(history(ctx, { tabId: 1 }, "back")).resolves.toEqual({
      navigated: true,
      entryId: 2,
    });
    await expect(history(ctx, { tabId: 1 }, "forward")).resolves.toEqual({
      navigated: true,
      entryId: 4,
    });
    await expect(stop(ctx, { tabId: 1 })).resolves.toEqual({ stopped: true });
  });

  it("reports missing history without navigating", async () => {
    const ctx = scriptedContext(
      { "Page.getNavigationHistory": () => ({ entries: [{ id: 2 }], currentIndex: 0 }) },
      tab,
    );
    await expect(history(ctx, { tabId: 1 }, "back")).resolves.toEqual({
      navigated: false,
      reason: "NO_BACK_HISTORY",
    });
    await expect(history(ctx, { tabId: 1 }, "forward")).resolves.toEqual({
      navigated: false,
      reason: "NO_FORWARD_HISTORY",
    });
  });
});

describe("navigation tools", () => {
  it("registers the five navigation tools", () => {
    expect(navigationTools.map((t) => t.name)).toEqual([
      "browser_navigate",
      "browser_reload",
      "browser_back",
      "browser_forward",
      "browser_stop",
    ]);
  });

  it("returns a thrown BrowserUseError as an isError result with its code", async () => {
    const out = await findTool(navigationTools, "browser_stop").run(scriptedContext({}, []), {
      tabId: 1,
    });
    expect(out.isError).toBe(true);
    expect(parseText(out)).toMatchObject({ error: { code: "TAB_NOT_CONNECTED" } });
  });
});
