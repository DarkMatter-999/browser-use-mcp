import { BrowserUseError, type JsonObject, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const MAX_TRACE_EVENTS = 2_000;
const MAX_TRACE_BYTES = 1024 * 1024;

const performanceShape = { tabId: tabIdField };
const traceShape = {
  tabId: tabIdField,
  durationMs: z.number().int().positive().max(30_000).optional(),
};
const traceInput = z.object({
  tabId: tabIdField,
  durationMs: z.number().int().positive().max(30_000).default(5_000),
});

export interface TraceOutcome {
  traceId: string;
  durationMs: number;
  events: { method: string; params: JsonObject }[];
  truncated: boolean;
}

export async function browserPerformance(
  ctx: ToolContext,
  input: { tabId: number },
): Promise<{ tabId: number; metrics: JsonValue }> {
  const { tabId } = z.object(performanceShape).parse(input);
  requireTab(ctx, tabId);
  try {
    await ctx.sendCommand(tabId, "Performance.enable", {});
    const result = asObject(await ctx.sendCommand(tabId, "Performance.getMetrics", {}));
    return { tabId, metrics: result.metrics ?? [] };
  } catch (error) {
    if (error instanceof BrowserUseError && error.code === "UNSUPPORTED_CDP_METHOD") {
      throw new BrowserUseError("UNSUPPORTED_CDP_METHOD", "Performance metrics are unavailable", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function browserTrace(
  ctx: ToolContext,
  input: z.input<typeof traceInput>,
): Promise<TraceOutcome> {
  const { tabId, durationMs } = traceInput.parse(input);
  requireTab(ctx, tabId);
  const id = `${tabId}:${crypto.randomUUID()}`;
  const events: { method: string; params: JsonObject }[] = [];
  let eventBytes = 0;
  const unsubscribe = ctx.subscribe(tabId, (method, params) => {
    if (!method.startsWith("Tracing.") || events.length >= MAX_TRACE_EVENTS) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify({ method, params }));
    } catch {
      return;
    }
    if (eventBytes + bytes <= MAX_TRACE_BYTES) {
      events.push({ method, params });
      eventBytes += bytes;
    }
  });
  let stopped = false;
  let resolveStop!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer.handle);
    unsubscribe();
    if (ctx.listTabs().some((tab) => tab.tabId === tabId)) {
      await ctx.sendCommand(tabId, "Tracing.end", {}, 5_000).catch(() => undefined);
    }
    resolveStop();
  };
  const removeListener = ctx.onTabRemoved((removedId) => {
    if (removedId === tabId) void stop();
  });
  try {
    await ctx.sendCommand(tabId, "Tracing.start", {
      transferMode: "ReportEvents",
      bufferUsageReportingInterval: 1_000,
    });
  } catch (error) {
    unsubscribe();
    removeListener();
    throw error;
  }
  timer.handle = setTimeout(() => {
    void stop();
  }, durationMs);
  await completed;
  removeListener();
  return {
    traceId: id,
    durationMs,
    events,
    truncated: events.length >= MAX_TRACE_EVENTS || eventBytes >= MAX_TRACE_BYTES,
  };
}

export const performanceTools = [
  defineTool({
    name: "browser_performance",
    title: "Performance metrics",
    description: "Read supported Performance domain metrics for a connected tab.",
    inputShape: performanceShape,
    handler: async (ctx, args) => jsonResult(await browserPerformance(ctx, args)),
  }),
  defineTool({
    name: "browser_trace",
    title: "Trace",
    description:
      "Collect a bounded tracing session for up to 30 seconds; tracing stops automatically on timeout or disconnect.",
    inputShape: traceShape,
    handler: async (ctx, args) => jsonResult(await browserTrace(ctx, args)),
  }),
];
