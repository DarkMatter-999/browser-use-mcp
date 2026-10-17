import type { JsonObject, JsonValue } from "@browser-use/protocol";
import type { AxNode } from "../refs/snapshot";

/** Marks the pointer overlay's host element (see overlay-script.ts). */
export const OVERLAY_ATTRIBUTE = "data-browser-use-overlay";

type Send = (method: string, params: JsonObject) => Promise<JsonValue>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The DOM nodeId of the overlay host under `rootNodeId`, if the page has one. Spec section 9:
 * the overlay is excluded from snapshots and DOM queries, so callers drop this node.
 */
export async function overlayHostNodeId(
  send: Send,
  rootNodeId: number,
): Promise<number | undefined> {
  try {
    const found = asRecord(
      await send("DOM.querySelector", { nodeId: rootNodeId, selector: `[${OVERLAY_ATTRIBUTE}]` }),
    );
    return typeof found.nodeId === "number" && found.nodeId > 0 ? found.nodeId : undefined;
  } catch {
    return undefined;
  }
}

/** The backend node id of the main document's overlay host, or undefined (none, or lookup failed). */
export async function overlayHostBackendId(send: Send): Promise<number | undefined> {
  try {
    const root = asRecord(asRecord(await send("DOM.getDocument", { depth: 0 })).root);
    if (typeof root.nodeId !== "number") return undefined;
    const nodeId = await overlayHostNodeId(send, root.nodeId);
    if (nodeId === undefined) return undefined;
    const node = asRecord(asRecord(await send("DOM.describeNode", { nodeId })).node);
    return typeof node.backendNodeId === "number" ? node.backendNodeId : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the AX node backed by `hostBackendId` and its whole subtree. */
export function withoutOverlay<
  T extends Pick<AxNode, "nodeId" | "parentId" | "childIds" | "backendDOMNodeId">,
>(nodes: T[], hostBackendId: number | undefined): T[] {
  if (hostBackendId === undefined) return nodes;
  const dropped = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const stack = nodes.filter((node) => node.backendDOMNodeId === hostBackendId);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || dropped.has(node.nodeId)) continue;
    dropped.add(node.nodeId);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) stack.push(child);
    }
  }
  // Nodes that only name their parent (no childIds on it) are caught by the parent check.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!dropped.has(node.nodeId) && node.parentId !== undefined && dropped.has(node.parentId)) {
        dropped.add(node.nodeId);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => !dropped.has(node.nodeId));
}
