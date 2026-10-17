import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { browserEmulate, browserResetEmulation } from "../src/tools/emulation";
import { browserCookies, browserStorage } from "../src/tools/storage";
import { scriptedContext } from "./helpers/context";

const tab = [{ tabId: 7, url: "https://example.test/path", title: "test" }];

function context(extra: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  return scriptedContext(
    {
      "Storage.getCookies": () => ({
        cookies: [{ name: "a", value: "secret", domain: "example.test", path: "/" }],
      }),
      "Network.deleteCookies": () => ({}),
      "Storage.setCookies": () => ({}),
      "Runtime.evaluate": () => ({ result: { type: "object", value: { key: "value" } } }),
      "Emulation.setDeviceMetricsOverride": () => ({}),
      "Emulation.clearDeviceMetricsOverride": () => ({}),
      "Emulation.setGeolocationOverride": () => ({}),
      "Network.emulateNetworkConditions": () => ({}),
      ...extra,
    },
    tab,
  );
}

describe("storage tools", () => {
  it("validates cookie domain and path without exposing cookie values", async () => {
    const ctx = context();
    await expect(
      browserCookies(ctx, { tabId: 7, operation: "get", domain: "other.test", path: "/" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      browserCookies(ctx, { tabId: 7, operation: "get", domain: "example.test", path: "relative" }),
    ).rejects.toThrow();
    const result = await browserCookies(ctx, {
      tabId: 7,
      operation: "get",
      domain: "example.test",
      path: "/",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    await browserCookies(ctx, {
      tabId: 7,
      operation: "delete",
      domain: "example.test",
      path: "/",
      name: "a",
    });
    expect(ctx.calls).toContainEqual({
      tabId: 7,
      method: "Network.deleteCookies",
      params: { name: "a", domain: "example.test", path: "/" },
    });
  });

  it("requires explicit valid storage operations and bounds returned data", async () => {
    const ctx = context();
    await expect(
      browserStorage(ctx, { tabId: 7, storage: "local", operation: "nope" } as never),
    ).rejects.toThrow();
    await expect(
      browserStorage(ctx, { tabId: 7, storage: "local", operation: "set", key: "k" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const result = await browserStorage(ctx, { tabId: 7, storage: "local", operation: "get" });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(65_536);
    expect(ctx.calls.some((call) => call.method === "Runtime.evaluate")).toBe(true);
  });

  it("caps page-context storage results before Runtime.evaluate crosses the bridge", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key-${index}`, "x".repeat(40_000)]),
    );
    const ctx = context({
      "Runtime.evaluate": (params) => {
        const storage = {
          get length() {
            return Object.keys(entries).length;
          },
          key(index: number) {
            return Object.keys(entries)[index] ?? null;
          },
          getItem(key: string) {
            return entries[key] ?? null;
          },
        };
        const value = runInNewContext(String(params.expression), {
          window: { localStorage: storage },
          TextEncoder,
        }) as unknown;
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(64 * 1024);
        return { result: { type: "object", value } };
      },
    });
    const result = await browserStorage(ctx, { tabId: 7, storage: "local", operation: "get" });
    expect(result).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65_536);
  });
});

describe("emulation tools", () => {
  it("validates viewport and geolocation values and drops overrides on disconnect", async () => {
    const ctx = context();
    await expect(
      browserEmulate(ctx, { tabId: 7, viewport: { width: 0, height: 500 } }),
    ).rejects.toThrow();
    await expect(
      browserEmulate(ctx, { tabId: 7, geolocation: { latitude: 91, longitude: 0 } }),
    ).rejects.toThrow();
    await browserEmulate(ctx, { tabId: 7, viewport: { width: 800, height: 600 }, offline: true });
    ctx.removeTab(7);
    await expect(browserResetEmulation(ctx, { tabId: 7 })).resolves.toMatchObject({
      reset: false,
    });
    expect(ctx.calls.map((call) => call.method)).not.toContain(
      "Emulation.clearDeviceMetricsOverride",
    );
  });

  it("restores tracked overrides on reset", async () => {
    const ctx = context();
    await expect(
      browserEmulate(ctx, { tabId: 7, viewport: { width: 800, height: 600 }, offline: true }),
    ).resolves.toMatchObject({ applied: ["viewport", "network"] });
    await expect(browserResetEmulation(ctx, { tabId: 7 })).resolves.toEqual({
      tabId: 7,
      reset: true,
    });
    const methods = ctx.calls.map((call) => call.method);
    expect(methods).toContain("Emulation.clearDeviceMetricsOverride");
    expect(ctx.calls.at(-1)).toMatchObject({
      method: "Network.emulateNetworkConditions",
      params: { offline: false },
    });
  });

  it("immediately drops removed-tab overrides", async () => {
    const ctx = context();
    await browserEmulate(ctx, { tabId: 7, offline: true });
    ctx.removeTab(7);
    await expect(browserResetEmulation(ctx, { tabId: 7 })).resolves.toMatchObject({
      cleaned: false,
    });
    expect(ctx.calls).toHaveLength(1);
  });
});
