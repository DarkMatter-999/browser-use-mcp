import { BrowserUseError, type JsonObject } from "@browser-use/protocol";
import { z } from "zod";
import { DiagnosticEventBuffer } from "../diagnostics/event-buffer";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { requireTab, tabIdField } from "./schema";

interface DiagnosticOutputEvent {
  sequence: number;
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface DiagnosticsPage {
  events: DiagnosticOutputEvent[];
  cursor: number;
  truncated: boolean;
}

const consoleShape = {
  tabId: tabIdField,
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
};
const networkShape = {
  ...consoleShape,
  includeBodies: z.boolean().optional(),
};
const clearShape = { tabId: tabIdField };

const COLLECTED_METHODS = [
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
  "Page.javascriptDialogOpening",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
];

const buffers = new WeakMap<ToolContext, DiagnosticEventBuffer>();
const subscriptions = new WeakMap<ToolContext, Map<number, () => void>>();
const enabledDomains = new WeakMap<ToolContext, Set<string>>();
const BODY_CAP = 1024 * 1024;
const AGGREGATE_BODY_CAP = 2 * 1024 * 1024;

export async function browserConsole(
  ctx: ToolContext,
  args: { tabId: number; cursor?: number; limit?: number },
): Promise<DiagnosticsPage> {
  assertConnected(ctx, args.tabId);
  await ensureCollecting(ctx, args.tabId, [
    "Console.enable",
    "Runtime.enable",
    "Log.enable",
    "Page.enable",
  ]);
  const result = bufferFor(ctx).read(args.tabId, args);
  const events = result.events.flatMap((entry): DiagnosticOutputEvent[] => {
    const data = entry.data;
    if (entry.method === "Runtime.consoleAPICalled") {
      return [
        {
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          type: data.type === "error" ? "error" : "console",
          level: data.type,
          args: safeArray(data.args),
        },
      ];
    }
    if (entry.method === "Runtime.exceptionThrown") {
      const detail = record(data.exceptionDetails);
      return [
        {
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          type: "exception",
          text: safeString(detail.text),
          exception: safeValue(detail.exception),
        },
      ];
    }
    if (entry.method === "Log.entryAdded") {
      const entryData = record(data.entry);
      return [
        {
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          type: entryData.level === "error" ? "error" : "log",
          level: safeString(entryData.level),
          text: safeString(entryData.text),
          url: safeString(entryData.url),
        },
      ];
    }
    if (entry.method === "Page.javascriptDialogOpening") {
      return [
        {
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          type: "dialog",
          message: safeString(data.message),
          dialogType: safeString(data.type),
          url: safeString(data.url),
        },
      ];
    }
    return [];
  });
  return { events, cursor: result.cursor, truncated: result.truncated };
}

export async function browserNetwork(
  ctx: ToolContext,
  args: { tabId: number; cursor?: number; limit?: number; includeBodies?: boolean },
): Promise<DiagnosticsPage> {
  assertConnected(ctx, args.tabId);
  await ensureCollecting(ctx, args.tabId, ["Network.enable"]);
  const result = bufferFor(ctx).read(args.tabId, args);
  const events: DiagnosticOutputEvent[] = [];
  let capturedBodyBytes = 0;
  for (const entry of result.events) {
    const data = entry.data;
    if (entry.method === "Network.requestWillBeSent") {
      const request = record(data.request);
      events.push({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        type: "request",
        requestId: safeString(data.requestId),
        url: safeString(request.url),
        method: safeString(request.method),
        resourceType: safeString(data.type),
      });
    }
    if (entry.method === "Network.responseReceived") {
      const response = record(data.response);
      const event: DiagnosticOutputEvent = {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        type: "response",
        requestId: safeString(data.requestId),
        url: safeString(response.url),
        status: response.status,
        mimeType: safeString(response.mimeType),
        headers: redactHeaders(response.headers),
      };
      if (args.includeBodies && typeof data.requestId === "string") {
        if (capturedBodyBytes >= AGGREGATE_BODY_CAP) {
          event.bodyTruncated = true;
        } else {
          const captured = await captureBody(ctx, args.tabId, data.requestId);
          if (captured.body !== undefined) {
            const bodyBytes = captured.bodyBytes ?? 0;
            if (bodyBytes > AGGREGATE_BODY_CAP - capturedBodyBytes) {
              event.bodyTruncated = true;
            } else {
              event.body = captured.body;
              capturedBodyBytes += bodyBytes;
            }
          }
          if (captured.bodyTruncated) event.bodyTruncated = true;
        }
      }
      events.push(event);
    }
    if (entry.method === "Network.loadingFailed") {
      events.push({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        type: "failure",
        requestId: safeString(data.requestId),
        errorText: safeString(data.errorText),
        canceled: data.canceled === true,
      });
    }
  }
  return { events, cursor: result.cursor, truncated: result.truncated };
}

export function browserClearDiagnostics(
  ctx: ToolContext,
  args: { tabId: number },
): Promise<{ tabId: number; cleared: true }> {
  bufferFor(ctx).clear(args.tabId);
  const enabled = enabledDomains.get(ctx);
  for (const key of enabled ?? []) {
    if (key.startsWith(`${args.tabId}:`)) enabled?.delete(key);
  }
  if (!ctx.listTabs().some((tab) => tab.tabId === args.tabId)) {
    subscriptions.get(ctx)?.get(args.tabId)?.();
    subscriptions.get(ctx)?.delete(args.tabId);
  }
  return Promise.resolve({ tabId: args.tabId, cleared: true });
}

async function ensureCollecting(ctx: ToolContext, tabId: number, methods: string[]): Promise<void> {
  const byTab = subscriptions.get(ctx) ?? new Map<number, () => void>();
  subscriptions.set(ctx, byTab);
  if (!byTab.has(tabId)) {
    const unsubscribe = ctx.subscribe(tabId, (method, params) => {
      if (COLLECTED_METHODS.includes(method)) {
        bufferFor(ctx).push(tabId, method, safeRecord(params));
      }
    });
    byTab.set(tabId, unsubscribe);
  }
  const enabled = enabledDomains.get(ctx) ?? new Set<string>();
  enabledDomains.set(ctx, enabled);
  try {
    for (const method of methods) {
      const domainKey = `${tabId}:${method}`;
      if (enabled.has(domainKey)) continue;
      await ctx.sendCommand(tabId, method, {});
      enabled.add(domainKey);
    }
  } catch (error) {
    byTab.get(tabId)?.();
    byTab.delete(tabId);
    for (const method of methods) enabled.delete(`${tabId}:${method}`);
    if (isUnsupported(error)) {
      throw new BrowserUseError(
        "UNSUPPORTED_CDP_METHOD",
        `Failed to enable diagnostic event domains: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function assertConnected(ctx: ToolContext, tabId: number): void {
  const active = new Set(ctx.listTabs().map((tab) => tab.tabId));
  const byTab = subscriptions.get(ctx);
  for (const known of byTab?.keys() ?? []) {
    if (!active.has(known)) {
      byTab?.get(known)?.();
      byTab?.delete(known);
      const enabled = enabledDomains.get(ctx);
      for (const key of enabled ?? []) {
        if (key.startsWith(`${known}:`)) enabled?.delete(key);
      }
      bufferFor(ctx).clear(known);
    }
  }
  requireTab(ctx, tabId);
}

function bufferFor(ctx: ToolContext): DiagnosticEventBuffer {
  let buffer = buffers.get(ctx);
  if (!buffer) {
    buffer = new DiagnosticEventBuffer();
    buffers.set(ctx, buffer);
  }
  return buffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupported(error: unknown): boolean {
  return (
    (error instanceof BrowserUseError && error.code === "UNSUPPORTED_CDP_METHOD") ||
    /UNSUPPORTED_CDP_METHOD|unsupported cdp method/i.test(errorMessage(error))
  );
}

interface CapturedBody {
  body?: string;
  bodyBytes?: number;
  bodyTruncated?: boolean;
}

async function captureBody(
  ctx: ToolContext,
  tabId: number,
  requestId: string,
): Promise<CapturedBody> {
  try {
    const result = record(
      await ctx.sendCommand(tabId, "Network.getResponseBody", { requestId }, 5_000),
    );
    if (typeof result.body !== "string") return {};
    const bytes =
      result.base64Encoded === true ? Buffer.from(result.body, "base64") : Buffer.from(result.body);
    if (bytes.byteLength > BODY_CAP) return { bodyTruncated: true };
    return {
      body: result.base64Encoded === true ? bytes.toString("utf8") : result.body,
      bodyBytes: bytes.byteLength,
    };
  } catch (error) {
    if (isUnsupported(error)) {
      throw new BrowserUseError(
        "UNSUPPORTED_CDP_METHOD",
        `Network.getResponseBody: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return {};
  }
}

function redactHeaders(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (key.toLowerCase() !== "set-cookie" && key.toLowerCase() !== "set-cookie2") {
      result[key] = safeValue(item);
    }
  }
  return result;
}

function safeRecord(value: unknown): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(record(value))) {
    const safe = safeValue(item);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function safeValue(value: unknown, depth = 0): JsonObject[string] | undefined {
  if (depth > 12) return "[depth limit]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => safeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const safe = safeValue(item, depth + 1);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }
  return undefined;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
        .slice(0, 100)
        .map((arg) => safeValue(record(arg).value ?? record(arg).description ?? arg))
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const diagnosticsTools = [
  defineTool({
    name: "browser_console",
    title: "Console messages",
    description:
      "Read bounded console messages, runtime exceptions, and log entries from a connected tab. Page-provided data is untrusted.",
    inputShape: consoleShape,
    handler: async (ctx, args) => jsonResult(await browserConsole(ctx, args)),
  }),
  defineTool({
    name: "browser_network",
    title: "Network activity",
    description:
      "Read bounded request/response metadata from a connected tab. Response bodies are omitted unless requested, limited to 1 MiB each and 2 MiB aggregate per call; Set-Cookie headers are always redacted.",
    inputShape: networkShape,
    handler: async (ctx, args) => jsonResult(await browserNetwork(ctx, args)),
  }),
  defineTool({
    name: "browser_clear_diagnostics",
    title: "Clear diagnostics",
    description: "Clear buffered console and network diagnostics for a connected tab.",
    inputShape: clearShape,
    handler: async (ctx, args) => jsonResult(await browserClearDiagnostics(ctx, args)),
  }),
];
