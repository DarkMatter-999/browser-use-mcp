import { BrowserUseError } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { imageResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const MAX_SCREENSHOT_BYTES = 1024 * 1024;

const inputShape = {
  tabId: tabIdField.describe("Tab id from browser_tabs"),
  format: z.enum(["png", "jpeg"]).optional().default("png"),
  quality: z.number().int().min(0).max(100).optional().describe("JPEG quality 0-100"),
};
const inputSchema = z.object(inputShape);

export interface ScreenshotOutcome {
  tabId: number;
  mimeType: string;
  data: string;
}

export async function screenshot(
  ctx: ToolContext,
  input: z.input<typeof inputSchema>,
): Promise<ScreenshotOutcome> {
  const args = inputSchema.parse(input);
  requireTab(ctx, args.tabId);
  const result = asObject(
    await ctx.sendCommand(
      args.tabId,
      "Page.captureScreenshot",
      {
        format: args.format,
        ...(args.format === "jpeg" && args.quality !== undefined ? { quality: args.quality } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      },
      30_000,
    ),
  );
  const data = typeof result.data === "string" ? result.data : "";
  const bytes = Buffer.from(data, "base64");
  if (!data || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new BrowserUseError("LIMIT_EXCEEDED", "Screenshot is empty or exceeds the 1 MiB limit", {
      hint: "Use format jpeg with a lower quality, or shrink the viewport.",
    });
  }
  return {
    tabId: args.tabId,
    mimeType: args.format === "png" ? "image/png" : "image/jpeg",
    data: bytes.toString("base64"),
  };
}

export const screenshotTools = [
  defineTool({
    name: "browser_screenshot",
    title: "Screenshot",
    description:
      "Capture the connected tab viewport and return a bounded (1 MiB) PNG or JPEG image.",
    inputShape,
    handler: async (ctx, args) => {
      const image = await screenshot(ctx, args);
      return imageResult(image.data, image.mimeType);
    },
  }),
];
