import { BrowserUseError, type JsonObject } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { OVERLAY_ATTRIBUTE, overlayHostBackendId, withoutOverlay } from "../pointer/overlay-filter";
import { asObject, requireTab, tabIdField } from "./schema";

const MAX_INSPECTION_JSON_BYTES = 1024 * 1024;

const domShape = {
  tabId: tabIdField,
  cursor: z.string().optional(),
  maxNodes: z.number().int().positive().max(1_000).optional(),
  maxDepth: z.number().int().positive().max(40).optional(),
};
const axShape = {
  tabId: tabIdField,
  cursor: z.string().optional(),
  maxNodes: z.number().int().positive().max(1_000).optional(),
};
const queryShape = {
  tabId: tabIdField,
  selector: z.string().min(1).max(2_000),
};

const tabInput = z.object({
  tabId: tabIdField,
  cursor: z.string().regex(/^\d+$/).optional().default("0"),
  maxNodes: z.number().int().positive().max(1_000).optional().default(500),
  maxDepth: z.number().int().positive().max(40).optional().default(20),
});
const queryInput = z.object(queryShape);

export interface BoundedSnapshot {
  tabId: number;
  nodes: Record<string, unknown>[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface QueryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QueryOutcome {
  tabId: number;
  found: boolean;
  tag?: string;
  text?: string;
  attributes?: Record<string, string>;
  box?: QueryBox;
  form?: Record<string, unknown>;
}

function capString(value: unknown, max = 2_048): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function attributes(
  flat: unknown,
  decode: (value: unknown) => string = (value) => capString(value),
): Record<string, string> {
  if (!Array.isArray(flat)) return {};
  const output: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length && Object.keys(output).length < 50; index += 2) {
    const name = decode(flat[index]).slice(0, 256);
    if (name && !/^on/i.test(name) && name.toLowerCase() !== "value") {
      output[name] = decode(flat[index + 1]);
    }
  }
  return output;
}

function hasOverlayAttribute(
  flat: unknown,
  decode: (value: unknown) => string = (value) => capString(value),
): boolean {
  if (!Array.isArray(flat)) return false;
  for (let index = 0; index < flat.length; index += 2) {
    if (decode(flat[index]).toLowerCase() === OVERLAY_ATTRIBUTE) return true;
  }
  return false;
}

function safeAttributeObject(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const safe: Record<string, string> = {};
  for (const [name, attributeValue] of Object.entries(value).slice(0, 50)) {
    if (/^on/i.test(name) || name.toLowerCase() === "value") continue;
    safe[name.slice(0, 256)] = capString(attributeValue);
  }
  return safe;
}

function safeFormMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const form = value as Record<string, unknown>;
  return {
    type: capString(form.type, 64),
    name: capString(form.name, 256),
    hasValue: form.hasValue === true || (typeof form.value === "string" && form.value.length > 0),
    value: "[redacted]",
    checked: form.checked === true,
    disabled: form.disabled === true,
  };
}

export async function domSnapshot(
  ctx: ToolContext,
  input: z.input<typeof tabInput>,
): Promise<BoundedSnapshot> {
  const args = tabInput.parse(input);
  requireTab(ctx, args.tabId);
  const response = asObject(
    await ctx.sendCommand(args.tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: true,
    }),
  );
  const source = record(record(asArray(response.documents)[0]).nodes);
  const strings = asArray(response.strings);
  const decodeString = (value: unknown): string =>
    typeof value === "number" && Number.isInteger(value)
      ? capString(strings[value])
      : capString(value);
  const names = asArray(source.nodeName);
  const parents = asArray(source.parentIndex);
  const attributeLists = asArray(source.attributes);
  const total = names.length;
  const offset = Number(args.cursor);
  const nodeDepth: number[] = [];
  const overlay: boolean[] = [];
  for (let index = 0; index < total; index += 1) {
    const parentIndex = Number(parents[index] ?? -1);
    nodeDepth[index] = parentIndex < 0 ? 0 : (nodeDepth[parentIndex] ?? 0) + 1;
    overlay[index] =
      hasOverlayAttribute(attributeLists[index], decodeString) ||
      (parentIndex >= 0 && overlay[parentIndex] === true);
  }
  const candidates = nodeDepth.map((_depth, index) => index).filter((index) => !overlay[index]);
  const visible = candidates.filter((index) => (nodeDepth[index] ?? 0) <= args.maxDepth);
  const page = visible.slice(offset, offset + args.maxNodes);
  const nodes: Record<string, unknown>[] = page.map((index) => ({
    index,
    parentIndex: Number(parents[index] ?? -1),
    nodeType: Number(asArray(source.nodeType)[index] ?? 0),
    nodeName: decodeString(names[index]).slice(0, 256),
    nodeValue: decodeString(asArray(source.nodeValue)[index]),
    backendNodeId: Number(asArray(source.backendNodeId)[index] ?? 0),
    attributes: attributes(attributeLists[index], decodeString),
  }));
  const hasMore = offset + nodes.length < visible.length;
  return boundedSnapshot(
    args.tabId,
    nodes,
    offset,
    visible.length,
    hasMore || visible.length < candidates.length,
  );
}

export async function accessibilitySnapshot(
  ctx: ToolContext,
  input: z.input<typeof tabInput>,
): Promise<BoundedSnapshot> {
  const args = tabInput.parse(input);
  requireTab(ctx, args.tabId);
  const response = asObject(await ctx.sendCommand(args.tabId, "Accessibility.getFullAXTree", {}));
  const all = asArray(response.nodes).map(record);
  const hostId = await overlayHostBackendId((method, params) =>
    ctx.sendCommand(args.tabId, method, params),
  );
  const kept = new Set(
    withoutOverlay(
      all.map((node, index) => ({
        nodeId: typeof node.nodeId === "string" ? node.nodeId : `#${index}`,
        ...(typeof node.parentId === "string" ? { parentId: node.parentId } : {}),
        childIds: asArray(node.childIds).filter((id): id is string => typeof id === "string"),
        ...(typeof node.backendDOMNodeId === "number"
          ? { backendDOMNodeId: node.backendDOMNodeId }
          : {}),
        index,
      })),
      hostId,
    ).map((node) => node.index),
  );
  const source = all.filter((_node, index) => kept.has(index));
  const depths = new Map<string, number>();
  for (const node of source) {
    const id = capString(node.nodeId, 256);
    const parentId = capString(node.parentId, 256);
    depths.set(id, parentId ? (depths.get(parentId) ?? 0) + 1 : 0);
  }
  const visible = source.filter(
    (node) => (depths.get(capString(node.nodeId, 256)) ?? 0) <= args.maxDepth,
  );
  const offset = Number(args.cursor);
  const nodes = visible.slice(offset, offset + args.maxNodes).map((node) => ({
    nodeId: capString(node.nodeId, 256),
    parentId: capString(node.parentId, 256),
    childIds: asArray(node.childIds)
      .slice(0, 100)
      .map((id) => capString(id, 256)),
    role: capString(record(node.role).value, 256),
    name: capString(record(node.name).value),
    value: record(node.value).value ? "[redacted]" : "",
    description: capString(record(node.description).value),
    ignored: node.ignored === true,
  }));
  const hasMore = offset + nodes.length < visible.length;
  return boundedSnapshot(
    args.tabId,
    nodes,
    offset,
    visible.length,
    hasMore || visible.length < source.length,
  );
}

function boundedSnapshot(
  tabId: number,
  nodes: Record<string, unknown>[],
  offset: number,
  visibleCount: number,
  alreadyTruncated: boolean,
): BoundedSnapshot {
  let truncated = alreadyTruncated;
  while (
    nodes.length > 0 &&
    Buffer.byteLength(JSON.stringify({ tabId, nodes, truncated: true, nextCursor: "0" }), "utf8") >
      MAX_INSPECTION_JSON_BYTES
  ) {
    nodes.pop();
    truncated = true;
  }
  const hasMore = offset + nodes.length < visibleCount;
  return {
    tabId,
    nodes,
    truncated: truncated || hasMore,
    nextCursor: hasMore ? String(offset + nodes.length) : null,
  };
}

function notFoundOverlay(selector: string): BrowserUseError {
  return new BrowserUseError("ELEMENT_NOT_FOUND", `No element matches ${selector}`, {
    hint: "Check the selector against browser_snapshot or browser_dom_snapshot.",
  });
}

export async function query(
  ctx: ToolContext,
  input: z.input<typeof queryInput>,
): Promise<QueryOutcome> {
  const args = queryInput.parse(input);
  requireTab(ctx, args.tabId);
  let found: JsonObject;
  try {
    const root = asObject(
      await ctx.sendCommand(args.tabId, "DOM.getDocument", { depth: 1, pierce: true }),
    );
    found = asObject(
      await ctx.sendCommand(args.tabId, "DOM.querySelector", {
        nodeId: asObject(root.root).nodeId ?? null,
        selector: args.selector,
      }),
    );
  } catch (error) {
    if (/selector|syntax|not a valid/i.test(String(error))) {
      throw new BrowserUseError("INVALID_ARGUMENT", `Invalid selector: ${String(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!found.nodeId) return { tabId: args.tabId, found: false };
  const described = asObject(
    await ctx.sendCommand(args.tabId, "DOM.describeNode", { nodeId: found.nodeId }),
  );
  const node = asObject(described.node);
  if (hasOverlayAttribute(node.attributes)) throw notFoundOverlay(args.selector);
  let box: QueryBox | undefined;
  try {
    const boxResponse = asObject(
      await ctx.sendCommand(args.tabId, "DOM.getBoxModel", { nodeId: found.nodeId }),
    );
    const points = asObject(boxResponse.model).content;
    if (Array.isArray(points) && points.length >= 8) {
      const xs = points.filter((_value, index) => index % 2 === 0).map(Number);
      const ys = points.filter((_value, index) => index % 2 === 1).map(Number);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      box = {
        x: left,
        y: top,
        width: Math.max(...xs) - left,
        height: Math.max(...ys) - top,
      };
    }
  } catch {
    /* box geometry is optional for detached or non-layout nodes */
  }
  const expression = `(() => { const e = document.querySelector(${JSON.stringify(args.selector)}); if (!e) return null; if (e.closest('[${OVERLAY_ATTRIBUTE}]')) return { overlay: true }; const r = e.getBoundingClientRect(); const attrs = {}; for (const a of Array.from(e.attributes).slice(0, 50)) if (!/^on/i.test(a.name) && a.name.toLowerCase() !== 'value') attrs[a.name] = a.value.slice(0, 2048); const type = e instanceof HTMLInputElement ? e.type : ''; return { tag: e.tagName, text: (e.innerText || e.textContent || '').slice(0, 4096), attributes: attrs, form: { type, name: e.name || '', hasValue: String(e.value ?? '').length > 0, value: '[redacted]', checked: Boolean(e.checked), disabled: Boolean(e.disabled) }, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; })()`;
  const evaluated = asObject(
    await ctx.sendCommand(args.tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }),
  );
  if (evaluated.exceptionDetails) {
    throw new BrowserUseError(
      "INTERNAL",
      `Query failed: ${capString(asObject(evaluated.exceptionDetails).text)}`,
    );
  }
  const value = asObject(asObject(evaluated.result).value);
  if (value.overlay === true) throw notFoundOverlay(args.selector);
  const rect = asObject(value.rect);
  const fallbackBox: QueryBox | undefined =
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.width === "number" &&
    typeof rect.height === "number"
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : undefined;
  const result: QueryOutcome = {
    tabId: args.tabId,
    found: true,
    tag: capString(value.tag ?? node.nodeName, 256),
    text: capString(value.text ?? "", 4_096),
    attributes: safeAttributeObject(value.attributes) ?? attributes(node.attributes),
  };
  const finalBox = box ?? fallbackBox;
  if (finalBox) result.box = finalBox;
  const form = safeFormMetadata(value.form);
  if (form) result.form = form;
  return result;
}

export const inspectTools = [
  defineTool({
    name: "browser_dom_snapshot",
    title: "DOM snapshot",
    description: "Return a bounded, paginated DOM snapshot for a connected tab.",
    inputShape: domShape,
    handler: async (ctx, args) => jsonResult(await domSnapshot(ctx, args)),
  }),
  defineTool({
    name: "browser_accessibility_snapshot",
    title: "Accessibility snapshot",
    description:
      "Return a bounded, paginated accessibility tree for a connected tab. For a compact tree with refs usable by click/fill/etc., use browser_snapshot.",
    inputShape: axShape,
    handler: async (ctx, args) => jsonResult(await accessibilitySnapshot(ctx, args)),
  }),
  defineTool({
    name: "browser_query",
    title: "Query element",
    description:
      "Query one CSS selector and return bounded text, safe attributes, box, and form metadata; page markup is never returned.",
    inputShape: queryShape,
    handler: async (ctx, args) => jsonResult(await query(ctx, args)),
  }),
];
