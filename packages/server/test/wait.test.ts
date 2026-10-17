import type { DownloadInfo } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import { beginAction } from "../src/tools/action-summary";
import { waitFor, waitTools } from "../src/tools/wait";
import { makeContext, scriptedContext } from "./helpers/context";
import { findTool, parseText } from "./helpers/tool";

const tab = [{ tabId: 1, url: "https://a/", title: "A" }];

describe("browser_wait", () => {
  it("waits for a bounded delay", async () => {
    vi.useFakeTimers();
    try {
      const ctx = scriptedContext({}, tab);
      const done = waitFor(ctx, { tabId: 1, condition: "delayMs", delayMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(done).resolves.toMatchObject({
        tabId: 1,
        condition: "delayMs",
        satisfied: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a selector to appear", async () => {
    let calls = 0;
    const ctx = scriptedContext(
      { "Runtime.evaluate": () => ({ result: { type: "boolean", value: ++calls >= 3 } }) },
      tab,
    );
    await expect(
      waitFor(ctx, { tabId: 1, condition: "selector", value: "#x", timeoutMs: 5000 }),
    ).resolves.toMatchObject({ satisfied: true });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("resolves load-state waits from a forwarded CDP event", async () => {
    const ctx = scriptedContext(
      {
        "Page.enable": () => ({}),
        "Runtime.evaluate": () => ({ result: { type: "string", value: "loading" } }),
      },
      tab,
    );
    const done = waitFor(ctx, { tabId: 1, condition: "loadState", value: "load", timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.emit(1, "Page.loadEventFired", {});
    await expect(done).resolves.toMatchObject({ satisfied: true });
  });

  it("does not report interactive while the document is still loading", async () => {
    const ctx = scriptedContext(
      {
        "Page.enable": () => ({}),
        "Runtime.evaluate": () => ({ result: { type: "string", value: "loading" } }),
      },
      tab,
    );
    await expect(
      waitFor(ctx, { tabId: 1, condition: "loadState", value: "interactive", timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("times out with TIMEOUT", async () => {
    const ctx = scriptedContext(
      { "Runtime.evaluate": () => ({ result: { type: "boolean", value: false } }) },
      tab,
    );
    await expect(
      waitFor(ctx, { tabId: 1, condition: "selector", value: "#never", timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("requires a connected tab", async () => {
    await expect(
      waitFor(scriptedContext({}, []), { tabId: 9, condition: "delayMs", delayMs: 1 }),
    ).rejects.toMatchObject({ code: "TAB_NOT_CONNECTED" });
  });

  it("fails when the tab detaches while waiting", async () => {
    const ctx = scriptedContext(
      { "Runtime.evaluate": () => ({ result: { type: "boolean", value: false } }) },
      tab,
    );
    const done = waitFor(ctx, { tabId: 1, condition: "selector", value: "#x", timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.removeTab(1);
    await expect(done).rejects.toMatchObject({ code: "TAB_NOT_CONNECTED" });
  });

  it.each(["selector", "url", "title"] as const)(
    "requires a value for %s (WAIT_VALUE_REQUIRED)",
    async (condition) => {
      await expect(
        waitFor(scriptedContext({}, tab), { tabId: 1, condition }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("requires a value") as string,
      });
    },
  );

  it("rejects an unknown load state (INVALID_LOAD_STATE)", async () => {
    await expect(
      waitFor(scriptedContext({}, tab), { tabId: 1, condition: "loadState", value: "networkidle" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("load state") as string,
    });
  });

  it("requires delayMs for the delay condition (WAIT_DELAY_REQUIRED)", async () => {
    await expect(
      waitFor(scriptedContext({}, tab), { tabId: 1, condition: "delayMs" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("delayMs") as string,
    });
  });
});

describe("wait tool", () => {
  const tool = findTool(waitTools, "browser_wait");

  it("is registered", () => {
    expect(waitTools.map((t) => t.name)).toEqual(["browser_wait"]);
  });

  it("returns the outcome as JSON", async () => {
    const ctx = scriptedContext({}, tab);
    expect(parseText(await tool.run(ctx, { tabId: 1, condition: "delayMs", delayMs: 0 }))).toEqual({
      tabId: 1,
      condition: "delayMs",
      satisfied: true,
    });
  });

  it("returns a thrown BrowserUseError as an isError result with its code", async () => {
    const out = await tool.run(scriptedContext({}, []), {
      tabId: 1,
      condition: "delayMs",
      delayMs: 1,
    });
    expect(out.isError).toBe(true);
    expect(parseText(out)).toMatchObject({ error: { code: "TAB_NOT_CONNECTED" } });
  });
});

describe("browser_wait download", () => {
  it("waits for a new download to complete", async () => {
    vi.useFakeTimers();
    let list: DownloadInfo[] = [
      {
        downloadId: 1,
        filename: "/old",
        url: "u",
        state: "complete" as const,
        bytesReceived: 1,
        totalBytes: 1,
        sequence: 1,
      },
    ];
    const ctx = makeContext({ listTabs: () => tab, listDownloads: () => Promise.resolve(list) });
    const waiting = waitFor(ctx, { tabId: 1, condition: "download", value: "report" });
    list = [
      ...list,
      {
        downloadId: 2,
        filename: "/tmp/report.pdf",
        url: "u",
        state: "in_progress" as const,
        bytesReceived: 0,
        totalBytes: 9,
        sequence: 2,
      },
    ];
    await vi.advanceTimersByTimeAsync(300);
    list = [
      {
        downloadId: 2,
        filename: "/tmp/report.pdf",
        url: "u",
        state: "complete",
        bytesReceived: 9,
        totalBytes: 9,
        sequence: 3,
      },
    ];
    await vi.advanceTimersByTimeAsync(300);
    await expect(waiting).resolves.toMatchObject({
      tabId: 1,
      condition: "download",
      satisfied: true,
      download: { filename: "/tmp/report.pdf", state: "complete" },
    });
    vi.useRealTimers();
  });

  it("finds a download that completed while the preceding click was settling, once", async () => {
    let list: DownloadInfo[] = [];
    const ctx = makeContext({ listTabs: () => tab, listDownloads: () => Promise.resolve(list) });
    await beginAction(ctx, 1);
    list = [
      {
        downloadId: 3,
        filename: "/tmp/report.txt",
        url: "u",
        state: "complete",
        bytesReceived: 9,
        totalBytes: 9,
        sequence: 2,
      },
    ];
    await expect(waitFor(ctx, { tabId: 1, condition: "download" })).resolves.toMatchObject({
      download: { downloadId: 3, state: "complete" },
    });
    await expect(
      waitFor(ctx, { tabId: 1, condition: "download", timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("fails when the awaited download is interrupted and times out otherwise", async () => {
    vi.useFakeTimers();
    let list: DownloadInfo[] = [];
    const ctx = makeContext({ listTabs: () => tab, listDownloads: () => Promise.resolve(list) });
    const failing = waitFor(ctx, { tabId: 1, condition: "download" });
    const failed = expect(failing).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("NETWORK_FAILED") as string,
    });
    list = [
      {
        downloadId: 5,
        filename: "",
        url: "u",
        state: "interrupted",
        bytesReceived: 0,
        totalBytes: 9,
        sequence: 5,
        error: "NETWORK_FAILED",
      },
    ];
    await vi.advanceTimersByTimeAsync(300);
    await failed;
    list = [];
    const timing = waitFor(ctx, { tabId: 1, condition: "download", timeoutMs: 500 });
    const timedOut = expect(timing).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(600);
    await timedOut;
    vi.useRealTimers();
  });
});
