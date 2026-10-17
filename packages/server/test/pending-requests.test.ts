import { BrowserUseError } from "@browser-use/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingRequests } from "../src/daemon/pending-requests";

afterEach(() => vi.useRealTimers());

describe("PendingRequests", () => {
  it("resolves and removes a request", async () => {
    const pending = new PendingRequests();
    const promise = pending.create("a", 1000);
    expect(pending.size).toBe(1);
    expect(pending.resolve("a", { ok: true })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(pending.size).toBe(0);
    expect(pending.resolve("a", 1)).toBe(false);
  });

  it("rejects with TIMEOUT after the timeout", async () => {
    vi.useFakeTimers();
    const pending = new PendingRequests();
    const promise = pending.create("a", 50);
    const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(pending.size).toBe(0);
  });

  it("rejectWhere only fails requests with the tag", async () => {
    const pending = new PendingRequests();
    const tagged = pending.create("a", 1000, 7);
    const other = pending.create("b", 1000, 8);
    const failed = expect(tagged).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    expect(pending.rejectWhere(7, new BrowserUseError("DIALOG_OPEN", "open"))).toBe(1);
    await failed;
    expect(pending.size).toBe(1);
    pending.resolve("b", 1);
    await expect(other).resolves.toBe(1);
  });

  it("rejectAll fails everything", async () => {
    const pending = new PendingRequests();
    const a = pending.create("a", 1000);
    const b = pending.create("b", 1000);
    const checks = [
      expect(a).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" }),
      expect(b).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" }),
    ];
    pending.rejectAll(new BrowserUseError("BRIDGE_DISCONNECTED", "gone"));
    await Promise.all(checks);
  });
});
