import type { JsonObject } from "@browser-use/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChooserWatch } from "../src/files/chooser-watch";
import { scriptedContext } from "./helpers/context";

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const ctx = scriptedContext({ "Page.setInterceptFileChooserDialog": () => ({}) }, tabs);
  const emit = (method: string, params: JsonObject) => {
    ctx.emit(1, method, params);
  };
  return { ctx, emit, watch: new ChooserWatch() };
}

describe("ChooserWatch", () => {
  it("enables interception once and disables it again when nothing opens", async () => {
    const { ctx, watch } = setup();
    await watch.armFor(ctx, 1, 1000);
    await watch.armFor(ctx, 1, 1000);
    const enabled = () =>
      ctx.calls
        .filter((c) => c.method === "Page.setInterceptFileChooserDialog")
        .map((c) => c.params.enabled);
    expect(enabled()).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(enabled()).toEqual([true, false]);
  });

  it("records a chooser and stays armed until it is taken", async () => {
    const { ctx, emit, watch } = setup();
    await watch.armFor(ctx, 1, 1000);
    emit("Page.fileChooserOpened", { frameId: "f", mode: "selectMultiple", backendNodeId: 55 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch.peek(1)).toMatchObject({ backendNodeId: 55, multiple: true });
    expect(
      ctx.calls
        .filter((c) => c.method === "Page.setInterceptFileChooserDialog")
        .map((c) => c.params.enabled),
    ).toEqual([true]);
    expect(watch.take(1)?.backendNodeId).toBe(55);
    expect(watch.peek(1)).toBeUndefined();
  });

  it("clear() forgets a pending chooser", async () => {
    const { ctx, emit, watch } = setup();
    await watch.armFor(ctx, 1, 1000);
    emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 9 });
    watch.clear(1);
    expect(watch.peek(1)).toBeUndefined();
  });
});
