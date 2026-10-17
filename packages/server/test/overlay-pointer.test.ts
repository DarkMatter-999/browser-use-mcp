import { describe, expect, it } from "vitest";
import { OverlayPointer } from "../src/pointer/overlay-pointer";
import { OVERLAY_SCRIPT } from "../src/pointer/overlay-script";
import { scriptedContext } from "./helpers/context";

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];
const expr = (v: unknown): string => (typeof v === "string" ? v : "");
const handlers = {
  "Page.addScriptToEvaluateOnNewDocument": () => ({ identifier: "1" }),
  "Runtime.evaluate": () => ({ result: { value: true } }),
};

describe("OverlayPointer", () => {
  it("sends nothing when disabled", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, false);
    await pointer.moveTo(1, 10, 20, "Click");
    const restore = await pointer.hideForCapture(1);
    await restore();
    expect(ctx.calls).toHaveLength(0);
    expect(pointer.enabled).toBe(false);
  });

  it("installs once per tab, then only evaluates moves", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, true);
    await pointer.moveTo(1, 10, 20, "Click ref e1");
    await pointer.moveTo(1, 30, 40, "Click ref e2");
    const adds = ctx.calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(adds).toHaveLength(1);
    expect(adds[0]?.params.source).toBe(OVERLAY_SCRIPT);
    const evals = ctx.calls
      .filter((c) => c.method === "Runtime.evaluate")
      .map((c) => expr(c.params.expression));
    expect(evals.some((e) => e === OVERLAY_SCRIPT)).toBe(true);
    expect(evals.at(-1)).toContain("moveTo(30,40,");
  });

  it("JSON-escapes and truncates the label so page code cannot be injected", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, true);
    await pointer.moveTo(1, 1, 2, `"); alert(1); ("${"x".repeat(200)}`);
    const sent = expr(ctx.calls.at(-1)?.params.expression);
    expect(sent).toContain(JSON.stringify(`"); alert(1); ("${"x".repeat(200)}`.slice(0, 80)));
    // the quote is escaped, so the payload stays inside the string literal
    expect(sent).toContain('(\\"xxx');
    expect(sent).not.toMatch(/[^\\]"\); alert/);
  });

  it("never throws when Chrome refuses (dialog open, detached tab, CSP)", async () => {
    const ctx = scriptedContext(
      {
        "Page.addScriptToEvaluateOnNewDocument": () => {
          throw new Error("DIALOG_OPEN");
        },
        "Runtime.evaluate": () => {
          throw new Error("nope");
        },
      },
      tabs,
    );
    const pointer = new OverlayPointer(ctx, true);
    await expect(pointer.moveTo(1, 1, 2, "x")).resolves.toBeUndefined();
    await expect((await pointer.hideForCapture(1))()).resolves.toBeUndefined();
  });

  it("hides for capture and restores afterwards", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, true);
    const restore = await pointer.hideForCapture(1);
    expect(expr(ctx.calls.at(-1)?.params.expression)).toContain(".hide()");
    await restore();
    expect(expr(ctx.calls.at(-1)?.params.expression)).toContain(".show()");
  });

  it("re-installs after the tab is removed and re-added", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, true);
    await pointer.moveTo(1, 1, 1, "a");
    ctx.removeTab(1);
    await pointer.moveTo(1, 1, 1, "b");
    expect(
      ctx.calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument"),
    ).toHaveLength(2);
  });

  it("skips non-finite coordinates", async () => {
    const ctx = scriptedContext(handlers, tabs);
    const pointer = new OverlayPointer(ctx, true);
    await pointer.moveTo(1, Number.NaN, 5, "x");
    expect(ctx.calls).toHaveLength(0);
  });
});
