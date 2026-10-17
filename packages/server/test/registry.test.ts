import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools";

const EXPECTED = [
  "browser_status",
  "browser_tabs",
  "browser_open_tab",
  "browser_close_tab",
  "browser_evaluate",
  "browser_navigate",
  "browser_reload",
  "browser_back",
  "browser_forward",
  "browser_stop",
  "browser_wait",
  "browser_dom_snapshot",
  "browser_accessibility_snapshot",
  "browser_query",
  "browser_screenshot",
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
  "browser_console",
  "browser_network",
  "browser_clear_diagnostics",
  "browser_cookies",
  "browser_storage",
  "browser_emulate",
  "browser_reset_emulation",
  "browser_performance",
  "browser_trace",
  "browser_pdf",
  "browser_snapshot",
  "browser_upload",
  "browser_downloads",
];

describe("tool registry", () => {
  it("exposes exactly the expected 38 tools", () => {
    const names = allTools.map((t) => t.name);
    expect([...names].sort()).toEqual([...EXPECTED].sort());
    expect(names).toHaveLength(38);
  });

  it("has unique browser_-prefixed names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith("browser_"))).toBe(true);
  });
});
