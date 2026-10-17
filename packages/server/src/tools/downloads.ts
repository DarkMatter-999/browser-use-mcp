import type { DownloadInfo } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";

const inputShape = {
  sinceSequence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only downloads with a higher sequence"),
  state: z.enum(["in_progress", "complete", "interrupted"]).optional(),
};
const inputSchema = z.object(inputShape);

export async function browserDownloads(
  ctx: ToolContext,
  input: z.input<typeof inputSchema>,
): Promise<{ downloads: DownloadInfo[] }> {
  const args = inputSchema.parse(input);
  const all = await ctx.listDownloads();
  const downloads = all
    .filter((d) => args.sinceSequence === undefined || d.sequence > args.sinceSequence)
    .filter((d) => args.state === undefined || d.state === args.state)
    .sort((a, b) => a.sequence - b.sequence);
  return { downloads };
}

export const downloadTools = [
  defineTool({
    name: "browser_downloads",
    title: "List downloads",
    description: "List downloads seen by the extension, ordered by sequence.",
    inputShape,
    handler: async (ctx, args) => jsonResult(await browserDownloads(ctx, args)),
  }),
];
