import { describe, expect, it, vi } from "vitest";
import type { BrowserConfig } from "../src/config";
import type { BrowserBackend } from "../src/daemon/backend";
import { selectBackend, waitForExtension } from "../src/daemon/select-backend";

function backend(kind: "extension" | "headless"): BrowserBackend {
  return {
    kind,
    capabilities: { cdp: true, downloads: true, dialogs: true, fileAccess: true, pointer: true },
    isConnected: () => true,
    listTabs: () => [],
    listDownloads: () => [],
    openTab: () => Promise.resolve(1),
    closeTab: () => Promise.resolve(),
    isFileAccessAllowed: () => Promise.resolve(true),
    sendCommand: () => Promise.resolve(null),
    subscribe: () => () => undefined,
    onTabsChanged: () => () => undefined,
    onTabRemoved: () => () => undefined,
    onDownloadsChanged: () => () => undefined,
    close: () => Promise.resolve(),
  };
}

const config = (mode: BrowserConfig["mode"]): BrowserConfig => ({ mode, profile: "default" });

describe("selectBackend", () => {
  it("uses extension mode without waiting for an extension or launching a browser", async () => {
    const extension = backend("extension");
    const waitForReady = vi.fn(() => Promise.resolve(false));
    const launch = vi.fn(() => Promise.resolve(backend("headless")));

    const selected = await selectBackend(config("extension"), {
      waitForExtension: waitForReady,
      createExtensionBackend: () => Promise.resolve(extension),
      createLaunchBackend: launch,
    });

    expect(selected.backend).toBe(extension);
    expect(waitForReady).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses headless mode directly without waiting for an extension", async () => {
    const headless = backend("headless");
    const waitForReady = vi.fn(() => Promise.resolve(true));
    const selected = await selectBackend(config("headless"), {
      waitForExtension: waitForReady,
      createExtensionBackend: () => Promise.resolve(backend("extension")),
      createLaunchBackend: () => Promise.resolve(headless),
    });

    expect(selected.backend).toBe(headless);
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it("prefers an extension that becomes ready at the auto startup deadline", async () => {
    const extension = backend("extension");
    const waitForExtension = vi.fn(() => Promise.resolve(true));
    const launch = vi.fn(() => Promise.resolve(backend("headless")));

    const selected = await selectBackend(config("auto"), {
      autoTimeoutMs: 500,
      waitForExtension,
      createExtensionBackend: () => Promise.resolve(extension),
      createLaunchBackend: launch,
    });

    expect(selected.backend).toBe(extension);
    expect(waitForExtension).toHaveBeenCalledWith(500);
    expect(launch).not.toHaveBeenCalled();
  });

  it("falls back to headless once at startup and records why", async () => {
    const headless = backend("headless");
    const selected = await selectBackend(config("auto"), {
      autoTimeoutMs: 25,
      waitForExtension: () => Promise.resolve(false),
      createExtensionBackend: () => Promise.resolve(backend("extension")),
      createLaunchBackend: () => Promise.resolve(headless),
    });

    expect(selected.backend).toBe(headless);
    expect(selected.fallbackReason).toMatch(/extension.*unavailable.*startup/i);
  });

  it("does not switch to headless after an extension disconnects mid-session", async () => {
    let connected = true;
    const extension = backend("extension");
    const disconnectingExtension = {
      ...extension,
      isConnected: () => connected,
    } satisfies BrowserBackend;
    const launch = vi.fn(() => Promise.resolve(backend("headless")));
    const selected = await selectBackend(config("extension"), {
      waitForExtension: () => Promise.resolve(false),
      createExtensionBackend: () => Promise.resolve(disconnectingExtension),
      createLaunchBackend: launch,
    });

    connected = false;
    expect(selected.backend.kind).toBe("extension");
    expect(selected.backend.isConnected()).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("waitForExtension", () => {
  it("resolves true for a ready peer and false on timeout", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const bridge = {
      peer: undefined,
      on: (_event: string, listener: () => void) => listeners.add(listener),
      off: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    const ready = waitForExtension(bridge, 100);
    listeners.values().next().value?.();
    await expect(ready).resolves.toBe(true);
    const timedOut = waitForExtension(bridge, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("counts a peer already ready when the startup deadline expires", async () => {
    vi.useFakeTimers();
    const state: { peer: unknown } = { peer: undefined };
    const bridge = {
      get peer() {
        return state.peer;
      },
      on: () => undefined,
      off: () => undefined,
    };
    const waiting = waitForExtension(bridge, 100);
    state.peer = {};
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("accepts readiness just before the deadline and ignores readiness after timeout", async () => {
    vi.useFakeTimers();
    const state: { peer: unknown; notifyReady?: () => void } = { peer: undefined };
    const bridge = {
      get peer() {
        return state.peer;
      },
      on: (event: string, listener: () => void) => {
        state.notifyReady = event === "ready" ? listener : undefined;
      },
      off: (event: string, listener: () => void) => {
        if (event === "ready" && state.notifyReady === listener) state.notifyReady = undefined;
      },
    };

    const justBefore = waitForExtension(bridge, 100);
    setTimeout(() => {
      state.peer = {};
      state.notifyReady?.();
    }, 99);
    await vi.advanceTimersByTimeAsync(99);
    await expect(justBefore).resolves.toBe(true);

    state.peer = undefined;
    const justAfter = waitForExtension(bridge, 100);
    const lateReady = state.notifyReady;
    await vi.advanceTimersByTimeAsync(100);
    await expect(justAfter).resolves.toBe(false);
    state.peer = {};
    lateReady?.();
    await expect(justAfter).resolves.toBe(false);
    vi.useRealTimers();
  });
});
