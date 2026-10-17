import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { assertOneTarget, objectIdFor, resolveTarget } from "../src/refs/target";
import { scriptedContext } from "./helpers/context";

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];
const quad = (x: number, y: number, w: number, h: number) => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

function ctxFor(extra: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const ctx = scriptedContext(
    {
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelectorAll": () => ({ nodeIds: [7] }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getBoxModel": () => ({ model: { content: quad(10, 20, 100, 40) } }),
      "DOM.describeNode": () => ({ node: { nodeId: 0 } }),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      ...extra,
    },
    tabs,
  );
  return ctx;
}

describe("assertOneTarget", () => {
  it("requires exactly one of ref and selector", () => {
    expect(() => {
      assertOneTarget({});
    }).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => {
      assertOneTarget({ ref: "e1", selector: "#a" });
    }).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => {
      assertOneTarget({ ref: "e1" });
    }).not.toThrow();
    expect(() => {
      assertOneTarget({ selector: "#a" });
    }).not.toThrow();
  });
});

describe("resolveTarget by selector", () => {
  it("never targets the pointer overlay host", async () => {
    const ctx = ctxFor({
      "DOM.querySelectorAll": () => ({ nodeIds: [7, 99] }),
      "DOM.querySelector": (params) =>
        params.selector === "[data-browser-use-overlay]" ? { nodeId: 99 } : { nodeId: 0 },
    });
    expect(await resolveTarget(ctx, 1, { selector: "html > div" })).toMatchObject({ nodeId: 7 });
    const onlyOverlay = ctxFor({
      "DOM.querySelectorAll": () => ({ nodeIds: [99] }),
      "DOM.querySelector": () => ({ nodeId: 99 }),
    });
    await expect(
      resolveTarget(onlyOverlay, 1, { selector: "html > div:last-child" }),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
  });

  it("returns the centre of the element box and scrolls it into view first", async () => {
    const ctx = ctxFor();
    const target = await resolveTarget(ctx, 1, { selector: "#go" });
    expect(target).toMatchObject({ tabId: 1, x: 60, y: 40, nodeId: 7 });
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.indexOf("DOM.scrollIntoViewIfNeeded")).toBeLessThan(
      methods.indexOf("DOM.getBoxModel"),
    );
  });

  it("maps no match to ELEMENT_NOT_FOUND and several matches to AMBIGUOUS_TARGET", async () => {
    await expect(
      resolveTarget(ctxFor({ "DOM.querySelectorAll": () => ({ nodeIds: [] }) }), 1, {
        selector: "#x",
      }),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
    await expect(
      resolveTarget(ctxFor({ "DOM.querySelectorAll": () => ({ nodeIds: [1, 2] }) }), 1, {
        selector: ".x",
      }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET" });
  });

  it("maps an invalid selector to INVALID_ARGUMENT", async () => {
    const ctx = ctxFor({
      "DOM.querySelectorAll": () => {
        throw new Error("DOM.querySelectorAll: not a valid selector");
      },
    });
    await expect(resolveTarget(ctx, 1, { selector: "[[" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("passes DIALOG_OPEN and other non-CDP errors through unchanged", async () => {
    const ctx = ctxFor({
      "DOM.getDocument": () => {
        throw new BrowserUseError("DIALOG_OPEN", "A alert dialog is open");
      },
    });
    await expect(resolveTarget(ctx, 1, { selector: "#a" })).rejects.toMatchObject({
      code: "DIALOG_OPEN",
    });
  });

  it("maps a missing or empty box to ELEMENT_NOT_INTERACTABLE", async () => {
    await expect(
      resolveTarget(ctxFor({ "DOM.getBoxModel": () => ({ model: { content: [] } }) }), 1, {
        selector: "#x",
      }),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
    await expect(
      resolveTarget(
        ctxFor({ "DOM.getBoxModel": () => ({ model: { content: quad(5, 5, 0, 0) } }) }),
        1,
        { selector: "#x" },
      ),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  });

  it("requires a connected tab", async () => {
    await expect(
      resolveTarget(scriptedContext({}, []), 9, { selector: "#x" }),
    ).rejects.toMatchObject({ code: "TAB_NOT_CONNECTED" });
  });
});

describe("resolveTarget by ref", () => {
  it("uses the backend node id from the snapshot", async () => {
    const ctx = ctxFor();
    ctx.refs.set(1, new Map([["e5", 321]]));
    const target = await resolveTarget(ctx, 1, { ref: "e5" });
    expect(target).toMatchObject({ backendNodeId: 321, x: 60, y: 40 });
    expect(ctx.calls.find((c) => c.method === "DOM.getBoxModel")?.params).toEqual({
      backendNodeId: 321,
    });
  });

  it("reports STALE_REF when the node no longer exists", async () => {
    const ctx = ctxFor({
      "DOM.describeNode": () => {
        throw new Error("Could not find node with given id");
      },
    });
    ctx.refs.set(1, new Map([["e5", 321]]));
    await expect(resolveTarget(ctx, 1, { ref: "e5" })).rejects.toMatchObject({ code: "STALE_REF" });
  });

  it("reports STALE_REF for refs from no snapshot", async () => {
    await expect(resolveTarget(ctxFor(), 1, { ref: "e1" })).rejects.toMatchObject({
      code: "STALE_REF",
    });
  });
});

describe("objectIdFor", () => {
  it("resolves by backendNodeId or nodeId", async () => {
    const ctx = ctxFor();
    expect(
      await objectIdFor(ctx, { tabId: 1, x: 0, y: 0, backendNodeId: 5, description: "d" }),
    ).toBe("obj-1");
    expect(ctx.calls.at(-1)?.params).toEqual({ backendNodeId: 5 });
    await objectIdFor(ctx, { tabId: 1, x: 0, y: 0, nodeId: 9, description: "d" });
    expect(ctx.calls.at(-1)?.params).toEqual({ nodeId: 9 });
  });
});
