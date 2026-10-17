import { BrowserUseError, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import { chooserWatch } from "../files/chooser-watch";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { assertOneTarget, objectIdFor, type ResolvedTarget, resolveTarget } from "../refs/target";
import { beginAction, finishAction } from "./action-summary";
import { requireTab, tabIdField, targetFields } from "./schema";

const MAX_TEXT = 10_000;
const MAX_DELTA = 1_000_000;
const MODIFIER_MASK = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

const FILL_FN = `function(value) {
  if (this.disabled) return false;
  if (this.isContentEditable) this.textContent = value;
  else if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) this.value = value;
  else return false;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;
const SELECT_FN = `function(value) {
  if (this.disabled || !(this instanceof HTMLSelectElement)) return false;
  if (!Array.from(this.options).some((option) => option.value === value)) return false;
  this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

const tabShape = { tabId: tabIdField.describe("Tab id from browser_tabs") };
const targetShape = { ...tabShape, ...targetFields };
const targetSchema = z.object(targetShape);
const valueShape = { ...targetShape, value: z.string().max(MAX_TEXT) };
const valueSchema = z.object(valueShape);
const typeShape = { ...targetShape, text: z.string().max(MAX_TEXT) };
const typeSchema = z.object(typeShape);
const endpointSchema = z.object({
  ref: targetFields.ref,
  selector: targetFields.selector,
});
const scrollShape = {
  ...tabShape,
  ...targetFields,
  deltaX: z.number().int().min(-MAX_DELTA).max(MAX_DELTA).optional().default(0),
  deltaY: z.number().int().min(-MAX_DELTA).max(MAX_DELTA),
};
const scrollSchema = z.object(scrollShape);
const keyShape = {
  ...tabShape,
  key: z.string().min(1).max(100),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .max(4)
    .optional()
    .default([]),
};
const keySchema = z.object(keyShape);
const dragShape = {
  ...tabShape,
  source: endpointSchema.describe("Element to drag: { ref } or { selector }"),
  destination: endpointSchema.describe("Drop target: { ref } or { selector }"),
};
const dragSchema = z.object(dragShape);
const dialogShape = {
  ...tabShape,
  accept: z.boolean(),
  promptText: z.string().max(MAX_TEXT).optional(),
};
const dialogSchema = z.object(dialogShape);

type Result = Record<string, JsonValue>;

async function mouse(
  ctx: ToolContext,
  tabId: number,
  type: string,
  x: number,
  y: number,
  buttons = type === "mousePressed" ? 1 : 0,
): Promise<void> {
  await ctx.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: type === "mousePressed" ? 1 : 0,
  });
}

async function pointTo(ctx: ToolContext, target: ResolvedTarget, label: string): Promise<void> {
  await ctx.pointer.moveTo(target.tabId, target.x, target.y, label).catch(() => undefined);
}

async function acting(
  ctx: ToolContext,
  tabId: number,
  perform: () => Promise<Result>,
): Promise<Result> {
  const marker = await beginAction(ctx, tabId);
  const base = await perform();
  return finishAction(ctx, tabId, base, marker);
}

export async function browserClick(ctx: ToolContext, input: z.input<typeof targetSchema>) {
  const args = targetSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    const target = await resolveTarget(ctx, args.tabId, args);
    await chooserWatch.armFor(ctx, args.tabId).catch(() => undefined);
    await pointTo(ctx, target, `Click ${target.description}`);
    await mouse(ctx, args.tabId, "mousePressed", target.x, target.y);
    await mouse(ctx, args.tabId, "mouseReleased", target.x, target.y);
    return { tabId: args.tabId, performed: true, action: "click", x: target.x, y: target.y };
  });
}

export async function browserType(ctx: ToolContext, input: z.input<typeof typeSchema>) {
  const args = typeSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    const target = await resolveTarget(ctx, args.tabId, args);
    await pointTo(ctx, target, `Type into ${target.description}`);
    await mouse(ctx, args.tabId, "mousePressed", target.x, target.y);
    await mouse(ctx, args.tabId, "mouseReleased", target.x, target.y);
    await ctx.sendCommand(args.tabId, "Input.insertText", { text: args.text });
    return { tabId: args.tabId, performed: true, action: "type", textLength: args.text.length };
  });
}

async function setValue(
  ctx: ToolContext,
  input: z.input<typeof valueSchema>,
  kind: "fill" | "select",
): Promise<Result> {
  const args = valueSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    const target = await resolveTarget(ctx, args.tabId, args);
    const objectId = await objectIdFor(ctx, target);
    const response = (await ctx.sendCommand(args.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: kind === "fill" ? FILL_FN : SELECT_FN,
      arguments: [{ value: args.value }],
      returnByValue: true,
    })) as { exceptionDetails?: unknown; result?: { value?: unknown } } | null;
    if (response?.exceptionDetails || response?.result?.value !== true) {
      throw new BrowserUseError(
        "ELEMENT_NOT_INTERACTABLE",
        kind === "fill"
          ? `${target.description} cannot be filled (not an enabled input, textarea or editable element)`
          : `${target.description} is not an enabled select with an option value ${JSON.stringify(args.value)}`,
        { hint: "Check the element with browser_snapshot." },
      );
    }
    return { tabId: args.tabId, performed: true, action: kind };
  });
}

export const browserFill = (ctx: ToolContext, input: z.input<typeof valueSchema>) =>
  setValue(ctx, input, "fill");
export const browserSelect = (ctx: ToolContext, input: z.input<typeof valueSchema>) =>
  setValue(ctx, input, "select");

export async function browserHover(ctx: ToolContext, input: z.input<typeof targetSchema>) {
  const args = targetSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    const target = await resolveTarget(ctx, args.tabId, args);
    await pointTo(ctx, target, `Hover ${target.description}`);
    await mouse(ctx, args.tabId, "mouseMoved", target.x, target.y);
    return { tabId: args.tabId, performed: true, action: "hover" };
  });
}

export async function browserFocus(ctx: ToolContext, input: z.input<typeof targetSchema>) {
  const args = targetSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    const target = await resolveTarget(ctx, args.tabId, args);
    await ctx.sendCommand(
      args.tabId,
      "DOM.focus",
      target.backendNodeId !== undefined
        ? { backendNodeId: target.backendNodeId }
        : { nodeId: target.nodeId ?? 0 },
    );
    return { tabId: args.tabId, performed: true, action: "focus" };
  });
}

export async function browserScroll(ctx: ToolContext, input: z.input<typeof scrollSchema>) {
  const args = scrollSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    requireTab(ctx, args.tabId);
    let x = 0;
    let y = 0;
    if (args.ref !== undefined || args.selector !== undefined) {
      assertOneTarget(args);
      const target = await resolveTarget(ctx, args.tabId, args);
      x = target.x;
      y = target.y;
    }
    await ctx.sendCommand(args.tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: args.deltaX,
      deltaY: args.deltaY,
    });
    return {
      tabId: args.tabId,
      performed: true,
      action: "scroll",
      deltaX: args.deltaX,
      deltaY: args.deltaY,
    };
  });
}

export async function browserPressKey(ctx: ToolContext, input: z.input<typeof keySchema>) {
  const args = keySchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    requireTab(ctx, args.tabId);
    const mask = args.modifiers.reduce((value, name) => value | MODIFIER_MASK[name], 0);
    await chooserWatch.armFor(ctx, args.tabId).catch(() => undefined);
    await ctx.sendCommand(args.tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: args.key,
      modifiers: mask,
    });
    await ctx.sendCommand(args.tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: args.key,
      modifiers: mask,
    });
    return { tabId: args.tabId, performed: true, action: "press_key", key: args.key };
  });
}

export async function browserDrag(ctx: ToolContext, input: z.input<typeof dragSchema>) {
  const args = dragSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    assertOneTarget(args.source, "source");
    assertOneTarget(args.destination, "destination");
    const from = await resolveTarget(ctx, args.tabId, args.source);
    const to = await resolveTarget(ctx, args.tabId, args.destination);
    await pointTo(ctx, from, `Drag from ${from.description}`);
    await mouse(ctx, args.tabId, "mousePressed", from.x, from.y);
    await pointTo(ctx, to, `Drag to ${to.description}`);
    await mouse(ctx, args.tabId, "mouseMoved", to.x, to.y, 1);
    await mouse(ctx, args.tabId, "mouseReleased", to.x, to.y);
    return { tabId: args.tabId, performed: true, action: "drag" };
  });
}

export async function browserHandleDialog(ctx: ToolContext, input: z.input<typeof dialogSchema>) {
  const args = dialogSchema.parse(input);
  return acting(ctx, args.tabId, async () => {
    requireTab(ctx, args.tabId);
    try {
      await ctx.sendCommand(args.tabId, "Page.handleJavaScriptDialog", {
        accept: args.accept,
        ...(args.promptText === undefined ? {} : { promptText: args.promptText }),
      });
    } catch (error) {
      throw new BrowserUseError("INVALID_ARGUMENT", "No dialog is open on this tab", {
        hint: error instanceof Error ? error.message : String(error),
      });
    }
    return { tabId: args.tabId, performed: true, action: "handle_dialog", accepted: args.accept };
  });
}

export const interactionTools = [
  defineTool({
    name: "browser_click",
    title: "Click",
    description:
      "Click an element by ref (from browser_snapshot) or CSS selector. CDP-dispatched input is not trusted physical user input.",
    inputShape: targetShape,
    handler: async (ctx, args) => jsonResult(await browserClick(ctx, args)),
  }),
  defineTool({
    name: "browser_type",
    title: "Type",
    description:
      "Click an element by ref or CSS selector, then type bounded text into it. CDP-dispatched input is not trusted physical user input.",
    inputShape: typeShape,
    handler: async (ctx, args) => jsonResult(await browserType(ctx, args)),
  }),
  defineTool({
    name: "browser_fill",
    title: "Fill",
    description:
      "Set a form control value and dispatch input/change events; this is page-scripted and is not trusted physical user input.",
    inputShape: valueShape,
    handler: async (ctx, args) => jsonResult(await browserFill(ctx, args)),
  }),
  defineTool({
    name: "browser_select",
    title: "Select option",
    description:
      "Select an option value in a select element using page-scripted events, not trusted physical input.",
    inputShape: valueShape,
    handler: async (ctx, args) => jsonResult(await browserSelect(ctx, args)),
  }),
  defineTool({
    name: "browser_hover",
    title: "Hover",
    description: "Move the pointer over an element selected by ref or CSS selector.",
    inputShape: targetShape,
    handler: async (ctx, args) => jsonResult(await browserHover(ctx, args)),
  }),
  defineTool({
    name: "browser_focus",
    title: "Focus",
    description: "Focus an element selected by ref or CSS selector.",
    inputShape: targetShape,
    handler: async (ctx, args) => jsonResult(await browserFocus(ctx, args)),
  }),
  defineTool({
    name: "browser_scroll",
    title: "Scroll",
    description:
      "Scroll a connected tab by bounded wheel deltas, optionally over an element selected by ref or CSS selector.",
    inputShape: scrollShape,
    handler: async (ctx, args) => jsonResult(await browserScroll(ctx, args)),
  }),
  defineTool({
    name: "browser_press_key",
    title: "Press key",
    description:
      "Dispatch a key press with validated modifiers; CDP input is not trusted physical user input.",
    inputShape: keyShape,
    handler: async (ctx, args) => jsonResult(await browserPressKey(ctx, args)),
  }),
  defineTool({
    name: "browser_drag",
    title: "Drag",
    description:
      "Drag between two elements (each { ref } or { selector }) using CDP-dispatched pointer input.",
    inputShape: dragShape,
    handler: async (ctx, args) => jsonResult(await browserDrag(ctx, args)),
  }),
  defineTool({
    name: "browser_handle_dialog",
    title: "Handle dialog",
    description: "Accept or dismiss a JavaScript dialog on a connected tab.",
    inputShape: dialogShape,
    handler: async (ctx, args) => jsonResult(await browserHandleDialog(ctx, args)),
  }),
];
