import { BrowserUseError, type JsonObject, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_DEPTH = 20;
const RESPONSE_GRACE_MS = 1000;
const OMITTED = "[Result omitted: serialization limit exceeded]";

const inputShape = {
  tabId: tabIdField.describe("Tab id from browser_tabs"),
  expression: z.string().min(1).describe("JavaScript expression to evaluate"),
  awaitPromise: z.boolean().optional().default(true).describe("Await a returned promise"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .default(10_000)
    .describe("Evaluation timeout in milliseconds (max 120000)"),
};
const inputSchema = z.object(inputShape);

export interface EvaluateOutcome {
  value?: JsonValue;
  unserializableValue?: string;
  truncated: boolean;
}

async function runEvaluate(
  ctx: ToolContext,
  tabId: number,
  expression: string,
  awaitPromise: boolean,
  timeoutMs: number,
): Promise<{ value?: JsonValue; unserializableValue?: string }> {
  const result = asObject(
    await ctx.sendCommand(
      tabId,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: false, timeout: timeoutMs },
      timeoutMs + RESPONSE_GRACE_MS,
    ),
  );
  const exception = result.exceptionDetails;
  if (exception !== undefined && exception !== null) {
    const details = asObject(exception);
    const description = asObject(details.exception).description;
    const text = typeof details.text === "string" ? details.text : "Evaluation failed";
    const descriptionText = typeof description === "string" ? description : undefined;
    if (/timed? ?out|timeout/i.test(`${text} ${descriptionText ?? ""}`)) {
      throw new BrowserUseError("TIMEOUT", `Evaluation timed out after ${timeoutMs} ms`, {
        hint: "Raise timeoutMs (max 120000) or simplify the expression.",
      });
    }
    const info: JsonObject = { text };
    if (descriptionText !== undefined) info.description = descriptionText;
    if (typeof details.lineNumber === "number") info.lineNumber = details.lineNumber;
    if (typeof details.columnNumber === "number") info.columnNumber = details.columnNumber;
    throw new BrowserUseError("PAGE_EXCEPTION", descriptionText ?? text, { details: info });
  }
  const remote = asObject(result.result);
  if (typeof remote.unserializableValue === "string") {
    return { unserializableValue: remote.unserializableValue };
  }
  if (remote.type === "undefined") return { unserializableValue: "undefined" };
  return remote.value === undefined ? {} : { value: remote.value };
}

function depth(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return MAX_DEPTH + 1;
  seen.add(value);
  return 1 + Math.max(0, ...Object.values(value).map((child) => depth(child, seen)));
}

export async function evaluate(
  ctx: ToolContext,
  input: z.input<typeof inputSchema>,
): Promise<EvaluateOutcome> {
  const args = inputSchema.parse(input);
  requireTab(ctx, args.tabId);
  let result: Awaited<ReturnType<typeof runEvaluate>>;
  try {
    result = await runEvaluate(ctx, args.tabId, args.expression, args.awaitPromise, args.timeoutMs);
  } catch (error) {
    // The extension refuses to send answers over the 2 MiB bridge limit; that is a large value.
    if (error instanceof BrowserUseError && error.code === "LIMIT_EXCEEDED") {
      return { value: OMITTED, truncated: true };
    }
    throw error;
  }
  let truncated = false;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result.value);
  } catch {
    truncated = true;
  }
  if (
    result.value !== undefined &&
    (truncated ||
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES ||
      depth(result.value) > MAX_DEPTH)
  ) {
    return { value: OMITTED, truncated: true };
  }
  return { ...result, truncated };
}

export const evaluateTools = [
  defineTool({
    name: "browser_evaluate",
    title: "Evaluate JavaScript",
    description:
      "Evaluate JavaScript in the page context of a connected tab. **Not sandboxed**: it can read and modify page state and trigger page side effects. Returns a bounded JSON result (1 MiB, depth 20).",
    inputShape,
    handler: async (ctx, args) => jsonResult(await evaluate(ctx, args)),
  }),
];
