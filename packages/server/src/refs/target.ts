import { BrowserUseError, type JsonObject } from "@browser-use/protocol";
import type { ToolContext } from "../mcp/context";
import { overlayHostNodeId } from "../pointer/overlay-filter";

type TargetContext = Pick<ToolContext, "listTabs" | "sendCommand" | "refs">;

export interface ResolvedTarget {
  tabId: number;
  x: number;
  y: number;
  nodeId?: number;
  backendNodeId?: number;
  description: string;
}

export function assertOneTarget(
  target: { ref?: string; selector?: string },
  label = "target",
): void {
  const given = [target.ref, target.selector].filter((value) => value !== undefined).length;
  if (given !== 1) {
    throw new BrowserUseError(
      "INVALID_ARGUMENT",
      `Provide exactly one of ref or selector for the ${label}`,
      {
        hint: "Use a ref from browser_snapshot, or a CSS selector.",
      },
    );
  }
}

function requireConnected(ctx: TargetContext, tabId: number): void {
  if (!ctx.listTabs().some((tab) => tab.tabId === tabId)) {
    throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not connected`, {
      hint: "Call browser_tabs to see the tabs you control.",
    });
  }
}

function centre(model: unknown): { x: number; y: number } {
  const quad = (model as { model?: { content?: unknown } } | undefined)?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) {
    throw new BrowserUseError("ELEMENT_NOT_INTERACTABLE", "The element has no visible box");
  }
  const xs = quad.filter((_, index) => index % 2 === 0).map(Number);
  const ys = quad.filter((_, index) => index % 2 === 1).map(Number);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.max(...xs) <= Math.min(...xs) ||
    Math.max(...ys) <= Math.min(...ys)
  ) {
    throw new BrowserUseError("ELEMENT_NOT_INTERACTABLE", "The element has an empty box");
  }
  return { x, y };
}

export async function resolveTarget(
  ctx: TargetContext,
  tabId: number,
  target: { ref?: string; selector?: string },
): Promise<ResolvedTarget> {
  assertOneTarget(target);
  requireConnected(ctx, tabId);
  const send = (method: string, params: JsonObject) => ctx.sendCommand(tabId, method, params);

  if (target.ref !== undefined) {
    const backendNodeId = ctx.refs.resolve(tabId, target.ref);
    try {
      await send("DOM.describeNode", { backendNodeId });
    } catch {
      ctx.refs.invalidate(tabId);
      throw new BrowserUseError("STALE_REF", `Ref ${target.ref} no longer exists on the page`, {
        hint: "Call browser_snapshot again for this tab and use the new refs.",
      });
    }
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    return {
      tabId,
      backendNodeId,
      ...centre(await send("DOM.getBoxModel", { backendNodeId })),
      description: `ref ${target.ref}`,
    };
  }

  const selector = target.selector ?? "";
  let nodeIds: unknown;
  let rootNodeId = 0;
  try {
    const root = (await send("DOM.getDocument", { depth: 1, pierce: true })) as {
      root: { nodeId: number };
    };
    rootNodeId = root.root.nodeId;
    nodeIds = (
      (await send("DOM.querySelectorAll", { nodeId: rootNodeId, selector })) as {
        nodeIds?: unknown;
      }
    ).nodeIds;
  } catch (error) {
    // Only Chrome's own rejection means a bad selector; transport and dialog errors pass through.
    if (error instanceof BrowserUseError && error.code !== "INTERNAL") throw error;
    throw new BrowserUseError(
      "INVALID_ARGUMENT",
      `Invalid selector ${selector}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let ids = Array.isArray(nodeIds) ? (nodeIds as number[]) : [];
  if (ids.length > 0) {
    // Spec section 9: the pointer overlay is never a target (e.g. `html > div:last-child`).
    // querySelectorAll does not enter its closed shadow root, so only the host can match.
    const host = await overlayHostNodeId(send, rootNodeId);
    if (host !== undefined) ids = ids.filter((id) => id !== host);
  }
  if (ids.length === 0) {
    throw new BrowserUseError("ELEMENT_NOT_FOUND", `No element matches ${selector}`, {
      hint: "Take a browser_snapshot to see what is on the page.",
    });
  }
  if (ids.length > 1) {
    throw new BrowserUseError("AMBIGUOUS_TARGET", `${selector} matched ${ids.length} elements`, {
      hint: "Make the selector more specific, or use a ref from browser_snapshot.",
    });
  }
  const nodeId = ids[0] ?? 0;
  await send("DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => undefined);
  return {
    tabId,
    nodeId,
    ...centre(await send("DOM.getBoxModel", { nodeId })),
    description: `selector ${selector}`,
  };
}

export async function objectIdFor(ctx: TargetContext, target: ResolvedTarget): Promise<string> {
  const params: JsonObject =
    target.backendNodeId !== undefined
      ? { backendNodeId: target.backendNodeId }
      : { nodeId: target.nodeId ?? 0 };
  const result = (await ctx.sendCommand(target.tabId, "DOM.resolveNode", params)) as {
    object?: { objectId?: string };
  };
  const objectId = result.object?.objectId;
  if (!objectId) {
    throw new BrowserUseError("STALE_REF", "The element could not be resolved", {
      hint: "Take a new browser_snapshot.",
    });
  }
  return objectId;
}
