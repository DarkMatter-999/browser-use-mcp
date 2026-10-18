import { describe, expect, it, vi } from "vitest";

describe("zod jitless config", () => {
  it("is applied before the protocol package builds its schemas, without calling Function", async () => {
    const OriginalFunction = globalThis.Function;
    const calls: unknown[][] = [];
    const Spy = new Proxy(OriginalFunction, {
      construct(target, args, newTarget) {
        calls.push(args);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    vi.stubGlobal("Function", Spy);
    vi.resetModules();
    try {
      await import("../src/zod-jitless.js");
      const { z } = await import("zod");
      const { parseWireMessage, PROTOCOL_VERSION } = await import("@browser-use/protocol");
      expect(z.config().jitless).toBe(true);
      const result = parseWireMessage(JSON.stringify({ type: "ping", version: PROTOCOL_VERSION }));
      expect(result).toBeDefined();
      expect(calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
