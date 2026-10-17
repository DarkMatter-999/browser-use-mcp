import { BrowserUseError, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const LOAD_STATES = ["load", "domcontentloaded", "interactive", "complete"];

const inputShape = {
  tabId: tabIdField.describe("Tab id from browser_tabs"),
  condition: z.enum(["loadState", "url", "title", "selector", "delayMs"]),
  value: z
    .string()
    .optional()
    .describe("Load state, exact URL, exact title or CSS selector, depending on condition"),
  delayMs: z.number().int().nonnegative().max(30_000).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional().default(10_000),
};
const inputSchema = z.object(inputShape);

export interface WaitOutcome {
  tabId: number;
  condition: string;
  satisfied: true;
}

function evalValue(result: JsonValue): JsonValue | undefined {
  return asObject(asObject(result).result).value;
}

export async function waitFor(
  ctx: ToolContext,
  input: z.input<typeof inputSchema>,
): Promise<WaitOutcome> {
  const args = inputSchema.parse(input);
  if (
    (args.condition === "selector" || args.condition === "url" || args.condition === "title") &&
    !args.value
  ) {
    throw new BrowserUseError("INVALID_ARGUMENT", "This wait condition requires a value");
  }
  if (args.condition === "loadState" && !LOAD_STATES.includes(args.value ?? "")) {
    throw new BrowserUseError("INVALID_ARGUMENT", `Unsupported load state ${args.value ?? ""}`, {
      hint: `Use one of: ${LOAD_STATES.join(", ")}.`,
    });
  }
  if (args.condition === "delayMs" && args.delayMs === undefined) {
    throw new BrowserUseError("INVALID_ARGUMENT", "delayMs condition requires delayMs");
  }
  requireTab(ctx, args.tabId);
  const start = Date.now();
  const deadline = start + args.timeoutMs;
  let eventSeen = false as boolean;
  const unsubscribe = ctx.subscribe(args.tabId, (method) => {
    if (
      args.condition === "loadState" &&
      ((args.value === "load" && method === "Page.loadEventFired") ||
        (args.value === "domcontentloaded" && method === "Page.domContentEventFired"))
    ) {
      eventSeen = true;
    }
  });
  try {
    if (args.condition === "loadState") {
      await ctx.sendCommand(args.tabId, "Page.enable", {}, 5_000);
    }
    while (Date.now() <= deadline) {
      if (!ctx.listTabs().some((tab) => tab.tabId === args.tabId)) {
        throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${args.tabId} detached while waiting`);
      }
      let satisfied = false;
      if (args.condition === "delayMs") {
        satisfied = Date.now() >= start + (args.delayMs ?? 0);
      } else if (args.condition === "loadState") {
        if (eventSeen) satisfied = true;
        else {
          const state = evalValue(
            await ctx.sendCommand(
              args.tabId,
              "Runtime.evaluate",
              { expression: "document.readyState", returnByValue: true },
              1_000,
            ),
          );
          const readyState = typeof state === "string" ? state : "";
          satisfied =
            args.value === "interactive" || args.value === "domcontentloaded"
              ? readyState !== "loading"
              : readyState === "complete";
        }
      } else {
        const expression =
          args.condition === "selector"
            ? `Boolean(document.querySelector(${JSON.stringify(args.value)}))`
            : args.condition === "url"
              ? `location.href === ${JSON.stringify(args.value)}`
              : `document.title === ${JSON.stringify(args.value)}`;
        const result = await ctx.sendCommand(
          args.tabId,
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          Math.max(1, deadline - Date.now()),
        );
        satisfied = evalValue(result) === true;
      }
      if (satisfied) return { tabId: args.tabId, condition: args.condition, satisfied: true };
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
      );
    }
    throw new BrowserUseError("TIMEOUT", `Timed out waiting for ${args.condition}`, {
      hint: "Raise timeoutMs (max 120000) or check the condition value.",
    });
  } finally {
    unsubscribe();
  }
}

export const waitTools = [
  defineTool({
    name: "browser_wait",
    title: "Wait",
    description: "Wait for a connected tab's load state, URL, title, selector, or a bounded delay.",
    inputShape,
    handler: async (ctx, args) => jsonResult(await waitFor(ctx, args)),
  }),
];
