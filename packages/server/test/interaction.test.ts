import { BrowserUseError, type ConnectedTab } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools";
import {
  browserClick,
  browserDrag,
  browserFill,
  browserFocus,
  browserHandleDialog,
  browserHover,
  browserPressKey,
  browserScroll,
  browserSelect,
  browserType,
  interactionTools,
} from "../src/tools/interaction";
import type { Pointer } from "../src/pointer/types";
import { scriptedContext } from "./helpers/context";
import { findTool, parseText } from "./helpers/tool";

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];
const quad = [0, 0, 100, 0, 100, 50, 0, 50];
const base = {
  "DOM.describeNode": () => ({ node: {} }),
  "DOM.scrollIntoViewIfNeeded": () => ({}),
  "DOM.getBoxModel": () => ({ model: { content: quad } }),
  "Input.dispatchMouseEvent": () => ({}),
  "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
};
const selectorBase = {
  ...base,
  "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
  "DOM.querySelectorAll": () => ({ nodeIds: [11] }),
};

function recordingPointer(): { pointer: Pointer; moves: [number, number, number][] } {
  const moves: [number, number, number][] = [];
  const pointer: Pointer = {
    enabled: true,
    ensureInstalled: () => Promise.resolve(),
    moveTo: (tabId, x, y) => {
      moves.push([tabId, x, y]);
      return Promise.resolve();
    },
    hideForCapture: () => Promise.resolve(() => Promise.resolve()),
  };
  return { pointer, moves };
}

describe("interaction with refs", () => {
  it("moves the agent pointer to the resolved centre before clicking", async () => {
    const { pointer, moves } = recordingPointer();
    const ctx = { ...scriptedContext(base, tabs), pointer };
    ctx.refs.set(1, new Map([["e1", 77]]));
    await browserClick(ctx, { tabId: 1, ref: "e1" });
    expect(moves).toEqual([[1, 50, 25]]);
  });

  it("clicks the centre of a ref'd element and reports where", async () => {
    const ctx = scriptedContext(base, tabs);
    ctx.refs.set(1, new Map([["e1", 77]]));
    const result = await browserClick(ctx, { tabId: 1, ref: "e1" });
    expect(result).toMatchObject({ tabId: 1, performed: true, action: "click", x: 50, y: 25 });
    const mouse = ctx.calls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params.type);
    expect(mouse).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("rejects ref and selector together, or neither", async () => {
    const ctx = scriptedContext(base, tabs);
    await expect(browserClick(ctx, { tabId: 1, ref: "e1", selector: "#a" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(browserClick(ctx, { tabId: 1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("fills through callFunctionOn on the resolved object", async () => {
    const ctx = scriptedContext(
      { ...base, "Runtime.callFunctionOn": () => ({ result: { type: "boolean", value: true } }) },
      tabs,
    );
    ctx.refs.set(1, new Map([["e2", 5]]));
    await browserFill(ctx, { tabId: 1, ref: "e2", value: "hello" });
    const call = ctx.calls.find((c) => c.method === "Runtime.callFunctionOn");
    expect(call?.params.objectId).toBe("o1");
    expect(JSON.stringify(call?.params.arguments)).toContain("hello");
    expect(call?.params.functionDeclaration as string).toContain("dispatchEvent");
  });

  it("reports ELEMENT_NOT_INTERACTABLE when the page function refuses the value", async () => {
    const ctx = scriptedContext(
      { ...base, "Runtime.callFunctionOn": () => ({ result: { type: "boolean", value: false } }) },
      tabs,
    );
    ctx.refs.set(1, new Map([["e2", 5]]));
    await expect(browserSelect(ctx, { tabId: 1, ref: "e2", value: "x" })).rejects.toMatchObject({
      code: "ELEMENT_NOT_INTERACTABLE",
    });
  });

  it("maps 'no dialog' from Chrome to INVALID_ARGUMENT", async () => {
    const ctx = scriptedContext(
      {
        "Page.handleJavaScriptDialog": () => {
          throw new Error("No dialog is showing");
        },
      },
      tabs,
    );
    await expect(browserHandleDialog(ctx, { tabId: 1, accept: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("actions that open a dialog", () => {
  const dialog = { type: "alert" as const, message: "hi", url: "https://a/" };

  it("reports the click as performed, with the dialog it opened", async () => {
    let current: ConnectedTab[] = tabs;
    const ctx = {
      ...scriptedContext({
        ...selectorBase,
        "Input.dispatchMouseEvent": (params) => {
          if (params.type !== "mouseReleased") return {};
          current = [{ tabId: 1, url: "https://a/", title: "A", pendingDialog: dialog }];
          throw new BrowserUseError("DIALOG_OPEN", "A alert dialog is open");
        },
      }),
    };
    ctx.listTabs = () => current;
    const result = await browserClick(ctx, { tabId: 1, selector: "#alert" });
    expect(result).toMatchObject({ performed: true, action: "click", dialog: { type: "alert" } });
  });

  it("still fails when the dialog was already open before the action", async () => {
    const ctx = scriptedContext(
      {
        "DOM.getDocument": () => {
          throw new BrowserUseError("DIALOG_OPEN", "A alert dialog is open");
        },
      },
      [{ tabId: 1, url: "https://a/", title: "A", pendingDialog: dialog }],
    );
    await expect(browserClick(ctx, { tabId: 1, selector: "#a" })).rejects.toMatchObject({
      code: "DIALOG_OPEN",
    });
  });
});

describe("interaction with selectors", () => {
  it("maps no-match and ambiguous selectors to error codes", async () => {
    let ids: number[] = [];
    const ctx = scriptedContext(
      { ...selectorBase, "DOM.querySelectorAll": () => ({ nodeIds: ids }) },
      tabs,
    );
    await expect(browserClick(ctx, { tabId: 1, selector: "#missing" })).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
    });
    ids = [1, 2];
    await expect(browserClick(ctx, { tabId: 1, selector: "button" })).rejects.toMatchObject({
      code: "AMBIGUOUS_TARGET",
    });
  });

  it("keeps the left button held from drag press through move", async () => {
    const ctx = scriptedContext(selectorBase, tabs);
    await browserDrag(ctx, {
      tabId: 1,
      source: { selector: ".source" },
      destination: { selector: ".destination" },
    });
    const events = ctx.calls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params);
    expect(events).toEqual([
      expect.objectContaining({ type: "mousePressed", button: "left", buttons: 1 }),
      expect.objectContaining({ type: "mouseMoved", button: "left", buttons: 1 }),
      expect.objectContaining({ type: "mouseReleased", button: "left", buttons: 0 }),
    ]);
  });

  it("requires exactly one target for each drag endpoint", async () => {
    const ctx = scriptedContext(selectorBase, tabs);
    await expect(
      browserDrag(ctx, { tabId: 1, source: {}, destination: { selector: "b" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("inserts text as a CDP payload", async () => {
    const ctx = scriptedContext(
      {
        ...selectorBase,
        "Input.dispatchKeyEvent": () => ({}),
        "Input.insertText": () => ({}),
        "DOM.focus": () => ({}),
      },
      tabs,
    );
    const text = `quote ' slash \\ newline\n and emoji 😀`;
    await browserType(ctx, { tabId: 1, selector: "input", text });
    expect(ctx.calls.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(
      (Array.from(new Intl.Segmenter().segment(text)).length - 1) * 2,
    );
    expect(
      ctx.calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text),
    ).toEqual(["\n"]);
    expect(ctx.calls.find((c) => c.method === "Input.dispatchMouseEvent")).toBeUndefined();
  });

  it("hovers and focuses", async () => {
    const ctx = scriptedContext({ ...selectorBase, "DOM.focus": () => ({}) }, tabs);
    expect(await browserHover(ctx, { tabId: 1, selector: "a" })).toMatchObject({ action: "hover" });
    expect(await browserFocus(ctx, { tabId: 1, selector: "a" })).toMatchObject({ action: "focus" });
    expect(ctx.calls.find((c) => c.method === "DOM.focus")?.params).toEqual({ nodeId: 11 });
  });

  it("scrolls with and without a target and presses keys with modifiers", async () => {
    const ctx = scriptedContext(
      { ...selectorBase, "Input.dispatchKeyEvent": () => ({}), "DOM.focus": () => ({}) },
      tabs,
    );
    await browserScroll(ctx, { tabId: 1, deltaY: 300 });
    await browserScroll(ctx, { tabId: 1, selector: "div", deltaY: 10 });
    const wheels = ctx.calls.filter((c) => c.params.type === "mouseWheel").map((c) => c.params);
    expect(wheels[0]).toMatchObject({ x: 0, y: 0, deltaY: 300, deltaX: 0 });
    expect(wheels[1]).toMatchObject({ x: 50, y: 25 });
    await browserPressKey(ctx, { tabId: 1, key: "A", modifiers: ["Control", "Shift"] });
    expect(
      ctx.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params),
    ).toEqual([
      expect.objectContaining({
        type: "keyDown",
        key: "A",
        code: "KeyA",
        modifiers: 10,
        windowsVirtualKeyCode: 65,
      }),
      expect.objectContaining({
        type: "keyUp",
        key: "A",
        code: "KeyA",
        modifiers: 10,
        windowsVirtualKeyCode: 65,
      }),
    ]);
  });

  it("supports space and focuses an optional press-key target", async () => {
    const ctx = scriptedContext(
      { ...selectorBase, "Input.dispatchKeyEvent": () => ({}), "DOM.focus": () => ({}) },
      tabs,
    );
    await browserPressKey(ctx, { tabId: 1, key: "Space", selector: "button" });
    expect(ctx.calls.find((c) => c.method === "DOM.focus")?.params).toEqual({ nodeId: 11 });
    expect(
      ctx.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params),
    ).toEqual([
      expect.objectContaining({ type: "keyDown", key: " ", code: "Space" }),
      expect.objectContaining({ type: "keyUp", key: " ", code: "Space" }),
    ]);
  });

  it("validates modifiers and scroll bounds", async () => {
    const ctx = scriptedContext(selectorBase, tabs);
    await expect(
      browserPressKey(ctx, { tabId: 1, key: "A", modifiers: ["Bogus" as never] }),
    ).rejects.toThrow();
    await expect(browserScroll(ctx, { tabId: 1, deltaY: 1_000_001 })).rejects.toThrow();
  });

  it("accepts a dialog with prompt text", async () => {
    const ctx = scriptedContext({ "Page.handleJavaScriptDialog": () => ({}) }, tabs);
    await browserHandleDialog(ctx, { tabId: 1, accept: true, promptText: "hi" });
    expect(ctx.calls[0]?.params).toEqual({ accept: true, promptText: "hi" });
  });

  it("rejects actions on a disconnected tab", async () => {
    const ctx = scriptedContext(selectorBase, []);
    await expect(browserClick(ctx, { tabId: 1, selector: "b" })).rejects.toMatchObject({
      code: "TAB_NOT_CONNECTED",
    });
  });
});

describe("interaction tool registration", () => {
  it("registers all ten tools and returns structured errors", async () => {
    expect(interactionTools.map((t) => t.name)).toEqual([
      "browser_click",
      "browser_type",
      "browser_fill",
      "browser_select",
      "browser_hover",
      "browser_focus",
      "browser_scroll",
      "browser_press_key",
      "browser_drag",
      "browser_handle_dialog",
    ]);
    for (const tool of interactionTools) expect(allTools).toContain(tool);
    const ctx = scriptedContext(base, tabs);
    const output = await findTool(allTools, "browser_click").run(ctx, { tabId: 1 });
    expect(output.isError).toBe(true);
    expect(parseText(output)).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});
