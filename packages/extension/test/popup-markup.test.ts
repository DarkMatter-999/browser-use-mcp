import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popup = readFileSync(new URL("../popup.html", import.meta.url), "utf8");

describe("popup settings disclosure", () => {
  it("starts collapsed and keeps the settings control and help inside the disclosure", () => {
    expect(popup).toMatch(/<details[^>]*class="settings"[^>]*>/);
    expect(popup).toMatch(/<summary[^>]*>\s*Settings\s*<\/summary>/);
    expect(popup).toMatch(/<details[^>]*class="settings"[^>]*>([\s\S]*?)<\/details>/);

    const settings = /<details[^>]*class="settings"[^>]*>([\s\S]*?)<\/details>/.exec(popup)?.[1];
    expect(settings).toContain('id="always-connected"');
    expect(settings).toContain('id="always-connected-help"');
  });
});
