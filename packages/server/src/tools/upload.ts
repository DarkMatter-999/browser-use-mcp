import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BrowserUseError } from "@browser-use/protocol";
import { z } from "zod";
import { chooserWatch } from "../files/chooser-watch";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { assertOneTarget, objectIdFor, resolveTarget } from "../refs/target";
import { beginAction, finishAction } from "./action-summary";
import { requireTab, tabIdField, targetFields } from "./schema";

const MAX_FILES = 20;
const IS_FILE_INPUT_FN =
  "function(){ return this instanceof HTMLInputElement && this.type === 'file'; }";
const FILE_COUNT_FN = "function(){ return this.files.length; }";

const inputShape = {
  tabId: tabIdField.describe("Tab id from browser_tabs"),
  ...targetFields,
  paths: z.array(z.string().min(1)).min(1).max(MAX_FILES).describe("Local file paths to upload"),
};
const inputSchema = z.object(inputShape);

export async function resolveUploadPaths(paths: string[]): Promise<string[]> {
  if (paths.length < 1 || paths.length > MAX_FILES) {
    throw new BrowserUseError("INVALID_ARGUMENT", `Provide between 1 and ${MAX_FILES} file paths`);
  }
  const resolved: string[] = [];
  for (const raw of paths) {
    const full = resolve(raw);
    let isFile = false;
    try {
      isFile = (await stat(full)).isFile();
    } catch {
      throw new BrowserUseError("INVALID_ARGUMENT", `File does not exist: ${full}`);
    }
    if (!isFile) throw new BrowserUseError("INVALID_ARGUMENT", `Not a regular file: ${full}`);
    resolved.push(full);
  }
  return resolved;
}

async function callValue(ctx: ToolContext, tabId: number, objectId: string, fn: string) {
  const response = (await ctx.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    returnByValue: true,
  })) as { exceptionDetails?: unknown; result?: { value?: unknown } } | null;
  return response?.exceptionDetails ? undefined : response?.result?.value;
}

export async function browserUpload(ctx: ToolContext, input: z.input<typeof inputSchema>) {
  const args = inputSchema.parse(input);
  requireTab(ctx, args.tabId);
  const files = await resolveUploadPaths(args.paths);
  const hasTarget = args.ref !== undefined || args.selector !== undefined;
  if (hasTarget) assertOneTarget(args);
  const marker = await beginAction(ctx, args.tabId);

  let nodeParams: { backendNodeId: number } | { nodeId: number };
  let objectId: string | undefined;
  let chooserId: number | undefined;
  if (hasTarget) {
    const target = await resolveTarget(ctx, args.tabId, args);
    objectId = await objectIdFor(ctx, target);
    if ((await callValue(ctx, args.tabId, objectId, IS_FILE_INPUT_FN)) !== true) {
      throw new BrowserUseError("INVALID_ARGUMENT", "Target is not a file input", {
        hint: "Pass the ref/selector of an input[type=file], or click the upload button first.",
      });
    }
    nodeParams =
      target.backendNodeId !== undefined
        ? { backendNodeId: target.backendNodeId }
        : { nodeId: target.nodeId ?? 0 };
  } else {
    const chooser = chooserWatch.peek(ctx, args.tabId);
    if (!chooser) {
      throw new BrowserUseError("ELEMENT_NOT_FOUND", "No file chooser is open", {
        hint: "Click the upload button first, or pass the file input's ref/selector",
      });
    }
    chooserId = chooser.backendNodeId;
    nodeParams = { backendNodeId: chooserId };
  }

  await ctx.sendCommand(args.tabId, "DOM.setFileInputFiles", { files, ...nodeParams });

  if (chooserId !== undefined) {
    chooserWatch.clear(ctx, args.tabId);
    const resolved = (await ctx.sendCommand(args.tabId, "DOM.resolveNode", {
      backendNodeId: chooserId,
    })) as { object?: { objectId?: string } } | null;
    objectId = resolved?.object?.objectId;
  }
  const count = objectId ? await callValue(ctx, args.tabId, objectId, FILE_COUNT_FN) : undefined;
  if (count !== files.length) {
    throw new BrowserUseError(
      "INTERNAL",
      `Upload failed: the page has ${typeof count === "number" ? count : "no"} files instead of ${files.length}`,
    );
  }
  return finishAction(
    ctx,
    args.tabId,
    { tabId: args.tabId, uploaded: files.length, files: files.map((f) => basename(f)) },
    marker,
  );
}

export const uploadTools = [
  defineTool({
    name: "browser_upload",
    title: "Upload files",
    description:
      "Set local files on an input[type=file] given by ref or CSS selector. Without a target, uses the file chooser opened by a preceding browser_click or browser_press_key.",
    inputShape,
    handler: async (ctx, args) => jsonResult(await browserUpload(ctx, args)),
  }),
];
