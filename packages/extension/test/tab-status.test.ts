import { describe, expect, it, vi } from "vitest";
import { detachAllTabs, TabLifecycle } from "../src/tabs/lifecycle";
import { TabStatus } from "../src/tabs/status";

describe("per-tab connection status", () => {
  it("distinguishes the state of two tabs", () => {
    const status = new TabStatus();
    status.set(101, "connected");
    status.set(202, "connecting");
    expect(status.get(101)).toBe("connected");
    expect(status.get(202)).toBe("connecting");
    expect(status.get(303)).toBe("disconnected");
  });

  it("detaches local debugger sessions and clears registrations when the peer becomes unavailable", () => {
    const status = new TabStatus();
    const tabs = new Set([101, 202]);
    const detach = (tabId: number) => detached.push(tabId);
    const detached: number[] = [];
    status.set(101, "connected");
    status.set(202, "connected");
    detachAllTabs(tabs, status, detach);
    expect(detached).toEqual([101, 202]);
    expect(tabs.size).toBe(0);
    expect(status.get(101)).toBe("disconnected");
  });

  it("disconnects after an in-flight attach finishes and removes its server registration", async () => {
    const lifecycle = new TabLifecycle();
    const status = new TabStatus();
    const tabs = new Set<number>();
    let registered = false;
    let releaseAttach!: () => void;
    const attachPending = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const attached = vi.fn(async () => {
      await attachPending;
    });
    const detach = vi.fn(() => Promise.resolve());
    const unregister = vi.fn(() => {
      registered = false;
      return Promise.resolve();
    });

    const connecting = lifecycle.connect(42, async () => {
      status.set(42, "connecting");
      await attached();
      tabs.add(42);
      registered = true;
      status.set(42, "connected");
    });
    await vi.waitFor(() => {
      expect(attached).toHaveBeenCalledOnce();
    });
    const disconnecting = lifecycle.disconnect(42, async () => {
      if (tabs.has(42)) await unregister();
      tabs.delete(42);
      await detach();
      status.set(42, "disconnected");
    });
    releaseAttach();
    await Promise.all([connecting, disconnecting]);

    expect(status.get(42)).toBe("disconnected");
    expect(detach).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(registered).toBe(false);
    expect(tabs.has(42)).toBe(false);
  });
});
