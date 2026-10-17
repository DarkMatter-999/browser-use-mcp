import { describe, expect, it } from "vitest";
import { DialogTracker } from "../src/daemon/dialog-tracker";

const opening = { type: "confirm", message: "Sure?", url: "https://a/", hasBrowserHandler: false };

describe("DialogTracker", () => {
  it("records an opening dialog and reports the change", () => {
    const tracker = new DialogTracker();
    expect(tracker.onEvent(1, "Page.javascriptDialogOpening", opening)).toBe(true);
    expect(tracker.get(1)).toEqual({ type: "confirm", message: "Sure?", url: "https://a/" });
  });

  it("keeps defaultPrompt for prompt dialogs", () => {
    const tracker = new DialogTracker();
    tracker.onEvent(1, "Page.javascriptDialogOpening", {
      ...opening,
      type: "prompt",
      defaultPrompt: "x",
    });
    expect(tracker.get(1)).toMatchObject({ type: "prompt", defaultPrompt: "x" });
  });

  it("clears on close and ignores unrelated events", () => {
    const tracker = new DialogTracker();
    tracker.onEvent(1, "Page.javascriptDialogOpening", opening);
    expect(tracker.onEvent(1, "Page.loadEventFired", {})).toBe(false);
    expect(tracker.onEvent(1, "Page.javascriptDialogClosed", { result: true })).toBe(true);
    expect(tracker.get(1)).toBeUndefined();
    expect(tracker.onEvent(1, "Page.javascriptDialogClosed", {})).toBe(false);
  });

  it("ignores dialog types it does not know and clear() removes a tab", () => {
    const tracker = new DialogTracker();
    expect(tracker.onEvent(2, "Page.javascriptDialogOpening", { ...opening, type: "weird" })).toBe(
      false,
    );
    tracker.onEvent(3, "Page.javascriptDialogOpening", opening);
    tracker.clear(3);
    expect(tracker.get(3)).toBeUndefined();
  });
});
