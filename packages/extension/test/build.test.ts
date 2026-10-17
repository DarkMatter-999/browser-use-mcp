import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ALLOWED_PERMISSIONS = ["activeTab", "debugger", "downloads", "storage", "tabGroups", "tabs"];

interface Manifest {
  manifest_version: number;
  name: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: string };
  action: { default_popup: string };
}

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "browser-use-ext-"));
  await build({
    root: join(import.meta.dirname, ".."),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
}, 60_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")) as Manifest;
}

describe("extension build", () => {
  it("emits a Manifest V3 manifest named Browser Use", async () => {
    const manifest = await readManifest();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("Browser Use");
  });

  it("requests only the allowlisted permissions and loopback host access", async () => {
    const manifest = await readManifest();
    for (const permission of manifest.permissions) {
      expect(ALLOWED_PERMISSIONS).toContain(permission);
    }
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
  });

  it("emits the service worker named in the manifest", async () => {
    const manifest = await readManifest();
    expect(manifest.background.type).toBe("module");
    expect(existsSync(join(outDir, manifest.background.service_worker))).toBe(true);
  });

  it("emits a popup page whose script and stylesheet exist", async () => {
    const manifest = await readManifest();
    const html = await readFile(join(outDir, manifest.action.default_popup), "utf8");
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    const style = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(style).toBeDefined();
    expect(existsSync(join(outDir, script ?? "missing"))).toBe(true);
    expect(existsSync(join(outDir, style ?? "missing"))).toBe(true);
  });
});
