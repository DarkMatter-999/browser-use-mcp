import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { type ToolOutput, textResult } from "../mcp/format";
import { watchNavigation } from "../refs/ref-store";
import { type AxNode, buildSnapshot } from "../refs/snapshot";
import type { RefStore } from "../refs/types";
import { asObject, requireTab, tabIdField } from "./schema";

const DEFAULT_MAX_NODES = 400;

const inputShape = {
  tabId: tabIdField.describe("Tab id from browser_tabs"),
  maxNodes: z.number().int().positive().max(1000).optional(),
};

const watchers = new WeakMap<RefStore, Map<number, () => void>>();

function watchOnce(ctx: ToolContext, tabId: number): void {
  let tabs = watchers.get(ctx.refs);
  if (!tabs) {
    tabs = new Map();
    watchers.set(ctx.refs, tabs);
  }
  if (tabs.has(tabId)) return;
  const stop = watchNavigation(ctx, ctx.refs, tabId);
  const stores = tabs;
  const stopRemoval = ctx.onTabRemoved((removed) => {
    if (removed !== tabId) return;
    stop();
    stopRemoval();
    stores.delete(tabId);
  });
  tabs.set(tabId, stop);
}

function collectFrameIds(tree: unknown): string[] {
  const ids: string[] = [];
  const walk = (entry: unknown): void => {
    const children = asObject(entry as never).childFrames;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      const id = asObject(asObject(child).frame).id;
      if (typeof id === "string") ids.push(id);
      walk(child);
    }
  };
  walk(asObject(tree as never).frameTree);
  return ids;
}

async function childFrameIds(ctx: ToolContext, tabId: number): Promise<string[]> {
  try {
    return collectFrameIds(await ctx.sendCommand(tabId, "Page.getFrameTree", {}));
  } catch {
    return [];
  }
}

async function takeSnapshot(
  ctx: ToolContext,
  tabId: number,
  maxNodes: number,
): Promise<ToolOutput> {
  requireTab(ctx, tabId);
  const tab = ctx.listTabs().find((entry) => entry.tabId === tabId);
  const tree = (await ctx.sendCommand(tabId, "Accessibility.getFullAXTree", {})) as {
    nodes?: AxNode[];
  };
  const main = buildSnapshot(tree.nodes ?? [], { maxNodes });
  const lines = [...main.lines];
  const refs = new Map(main.refs);
  let truncated = main.truncated;
  let nextRef = main.nextRef;
  for (const frameId of await childFrameIds(ctx, tabId)) {
    const remaining = maxNodes - lines.length - 1;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let nodes: AxNode[];
    try {
      nodes =
        (
          (await ctx.sendCommand(tabId, "Accessibility.getFullAXTree", { frameId })) as {
            nodes?: AxNode[];
          }
        ).nodes ?? [];
    } catch {
      continue;
    }
    const frame = buildSnapshot(nodes, { refStart: nextRef, baseDepth: 1, maxNodes: remaining });
    if (frame.lines.length === 0) continue;
    lines.push("- iframe", ...frame.lines);
    for (const [ref, id] of frame.refs) refs.set(ref, id);
    nextRef = frame.nextRef;
    truncated ||= frame.truncated;
  }
  ctx.refs.set(tabId, refs);
  watchOnce(ctx, tabId);
  const header = [
    `Page: ${tab?.title ?? ""} (${tab?.url ?? ""})`,
    "Refs (e1, e2, …) are valid until the page navigates or you take a new snapshot.",
    ...(truncated
      ? [`Output truncated at ${maxNodes} nodes; narrow the task or raise maxNodes.`]
      : []),
  ];
  return textResult([...header, "", ...lines].join("\n"));
}

export const snapshotTools = [
  defineTool({
    name: "browser_snapshot",
    title: "Accessibility snapshot",
    description:
      "Return a text accessibility snapshot of a connected tab. Interactive elements carry refs (e1, e2, …) usable as targets in other tools. Includes same-process iframe content; cross-origin iframes may be missing.",
    inputShape,
    handler: async (ctx, args) => takeSnapshot(ctx, args.tabId, args.maxNodes ?? DEFAULT_MAX_NODES),
  }),
];
