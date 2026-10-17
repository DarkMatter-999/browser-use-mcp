import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { OVERLAY_SCRIPT } from "../src/pointer/overlay-script";

describe("OVERLAY_SCRIPT", () => {
  it("is a self-contained, idempotent IIFE that never intercepts input", () => {
    expect(OVERLAY_SCRIPT.trim().startsWith("(")).toBe(true);
    expect(OVERLAY_SCRIPT).toContain("window.__browserUseOverlay");
    expect(OVERLAY_SCRIPT).toContain("data-browser-use-overlay");
    expect(OVERLAY_SCRIPT).toContain('attachShadow({ mode: "closed" })');
    expect(OVERLAY_SCRIPT).toContain("showPopover");
    expect(OVERLAY_SCRIPT).toMatch(/pointer-events:\s*none/);
  });

  it("parses as JavaScript", () => {
    expect(() => new vm.Script(OVERLAY_SCRIPT)).not.toThrow();
  });

  it("uses textContent (not innerHTML) for the page-visible label", () => {
    expect(OVERLAY_SCRIPT).toContain("textContent");
    expect(OVERLAY_SCRIPT.match(/\.innerHTML\s*=/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
