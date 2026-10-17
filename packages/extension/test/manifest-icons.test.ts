import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
  action: { default_icon: Record<string, string> };
  icons: Record<string, string>;
}

const publicDir = new URL("../public/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as ExtensionManifest;

describe("extension icons", () => {
  it("declares the Browser Use icon for toolbar and extension surfaces", () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    expect(Object.keys(manifest.action.default_icon).sort()).toEqual(["16", "32", "48"]);

    for (const path of [
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ]) {
      expect(existsSync(new URL(path, publicDir))).toBe(true);
    }
  });
});
