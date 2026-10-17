import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTENSION_ID } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { deriveExtensionId } from "../src/shared/extension-id";

interface Manifest {
  key?: string;
}

describe("extension identity", () => {
  it("derives the documented Chrome ID format", async () => {
    // Known vector: any SPKI base64 yields 32 chars in a-p.
    const id = await deriveExtensionId("AAAA");
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it("pins a manifest key whose derived ID equals EXTENSION_ID", async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "public", "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.key).toBeTruthy();
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(await deriveExtensionId(manifest.key ?? "")).toBe(EXTENSION_ID);
  });
});
