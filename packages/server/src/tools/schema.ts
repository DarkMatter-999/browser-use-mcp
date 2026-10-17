import { BrowserUseError, type JsonObject, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";

export const tabIdField = z.number().int().positive();

export const targetFields = {
  ref: z
    .string()
    .regex(/^e\d+$/)
    .optional()
    .describe("Element ref from browser_snapshot"),
  selector: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("CSS selector; use when there is no ref"),
};

export function requireTab(ctx: ToolContext, tabId: number): void {
  if (!ctx.listTabs().some((tab) => tab.tabId === tabId)) {
    throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`, {
      hint: "Call browser_tabs to see the tabs you control.",
    });
  }
}

export function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
