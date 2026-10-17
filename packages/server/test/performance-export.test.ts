import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import { browserPdf } from "../src/tools/export";
import { browserPerformance, browserTrace } from "../src/tools/performance";
import { scriptedContext } from "./helpers/context";

const tab = [{ tabId: 7, url: "https://a/", title: "A" }];

describe("performance and export tools", () => {
  it("returns a stable unsupported error when capability is unavailable", async () => {
    const ctx = scriptedContext(
      {
        "Performance.enable": () => {
          throw new BrowserUseError("UNSUPPORTED_CDP_METHOD", "unsupported");
        },
      },
      tab,
    );
    await expect(browserPerformance(ctx, { tabId: 7 })).rejects.toMatchObject({
      code: "UNSUPPORTED_CDP_METHOD",
    });
  });

  it("reads performance metrics", async () => {
    const ctx = scriptedContext(
      {
        "Performance.enable": () => ({}),
        "Performance.getMetrics": () => ({ metrics: [{ name: "TaskDuration", value: 1 }] }),
      },
      tab,
    );
    await expect(browserPerformance(ctx, { tabId: 7 })).resolves.toEqual({
      tabId: 7,
      metrics: [{ name: "TaskDuration", value: 1 }],
    });
  });

  it("ends a trace after its bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const ctx = scriptedContext({ "Tracing.start": () => ({}), "Tracing.end": () => ({}) }, tab);
      const tracing = browserTrace(ctx, { tabId: 7, durationMs: 20 });
      await vi.waitFor(() => {
        expect(ctx.calls.map((c) => c.method)).toContain("Tracing.start");
      });
      ctx.emit(7, "Tracing.dataCollected", { value: [] });
      ctx.emit(7, "Page.loadEventFired", {});
      await vi.advanceTimersByTimeAsync(20);
      const result = await tracing;
      expect(ctx.calls.filter((c) => c.method === "Tracing.end")).toHaveLength(1);
      expect(result.events).toEqual([{ method: "Tracing.dataCollected", params: { value: [] } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops tracing when the target disconnects", async () => {
    const ctx = scriptedContext({ "Tracing.start": () => ({}), "Tracing.end": () => ({}) }, tab);
    const tracing = browserTrace(ctx, { tabId: 7, durationMs: 30_000 });
    await vi.waitFor(() => {
      expect(ctx.calls.map((c) => c.method)).toContain("Tracing.start");
    });
    ctx.removeTab(7);
    await expect(tracing).resolves.toMatchObject({ durationMs: 30_000 });
  });

  it("uses bounded stream reads, returns MIME type, and closes the stream", async () => {
    const ctx = scriptedContext(
      {
        "Page.printToPDF": () => ({ stream: "pdf-stream" }),
        "IO.read": () => ({ data: Buffer.from("%PDF-test").toString("base64"), eof: true }),
        "IO.close": () => ({}),
      },
      tab,
    );
    const result = await browserPdf(ctx, { tabId: 7 });
    expect(result.mimeType).toBe("application/pdf");
    expect(Buffer.from(result.data, "base64").toString()).toBe("%PDF-test");
    expect(ctx.calls[0]).toMatchObject({
      method: "Page.printToPDF",
      params: { transferMode: "ReturnAsStream", printBackground: true, landscape: false },
    });
    const reads = ctx.calls.filter((c) => c.method === "IO.read");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => Number(c.params.size) <= 64 * 1024)).toBe(true);
    expect(ctx.calls).toContainEqual({
      tabId: 7,
      method: "IO.close",
      params: { handle: "pdf-stream" },
    });
  });

  it("rejects an oversized streamed PDF and closes its stream", async () => {
    let readCount = 0;
    const ctx = scriptedContext(
      {
        "Page.printToPDF": () => ({ stream: "pdf-stream" }),
        "IO.read": (params) => {
          readCount++;
          return { data: Buffer.alloc(Number(params.size)).toString("base64"), eof: false };
        },
        "IO.close": () => ({}),
      },
      tab,
    );
    await expect(browserPdf(ctx, { tabId: 7 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(readCount).toBeLessThanOrEqual(17);
    expect(ctx.calls.map((c) => c.method)).toContain("IO.close");
  });
});
