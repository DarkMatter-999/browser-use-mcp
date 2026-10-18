import { describe, expect, it, vi } from "vitest";
import type { BrowserConfig } from "../src/config";
import type { BrowserBackend } from "../src/daemon/backend";
import { initializeBrowserBackend, type BridgeLifecycle } from "../src/daemon/select-backend";

function backend(
  kind: "extension" | "headless",
  close = vi.fn(() => Promise.resolve()),
): BrowserBackend {
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
    close,
  };
}

function makeBridge(ready: boolean, calls: string[]): BridgeLifecycle {
  const listeners = new Set<() => void>();
  return {
    peer: ready ? {} : undefined,
    on: (_event, listener) => {
      listeners.add(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    },
    start() {
      calls.push("bridge-start");
      return Promise.resolve();
    },
    close() {
      calls.push("bridge-close");
      return Promise.resolve();
    },
  };
}

const config = (mode: BrowserConfig["mode"]): BrowserConfig => ({ mode, profile: "default" });

describe("initializeBrowserBackend", () => {
  it("does not start an extension bridge in explicit headless mode", async () => {
    const calls: string[] = [];
    const selected = await initializeBrowserBackend(config("headless"), {
      createBridge: () => {
        calls.push("create-bridge");
        return makeBridge(false, calls);
      },
      createExtensionBackend: () => backend("extension"),
      createLaunchBackend: () => {
        calls.push("launch");
        return Promise.resolve(backend("headless"));
      },
    });

    expect(calls).toEqual(["launch"]);
    expect(selected.backend.kind).toBe("headless");
    await selected.close();
  });

  it("starts the extension bridge and selects a ready extension before returning", async () => {
    const calls: string[] = [];
    const selected = await initializeBrowserBackend(config("auto"), {
      createBridge: () => makeBridge(true, calls),
      createExtensionBackend: () => {
        calls.push("extension-backend");
        return backend("extension");
      },
      createLaunchBackend: () => Promise.resolve(backend("headless")),
    });

    expect(calls).toEqual(["bridge-start", "extension-backend"]);
    expect(selected.backend.kind).toBe("extension");
    await selected.close();
    expect(calls.at(-1)).toBe("bridge-close");
  });

  it("closes the unused extension bridge after auto falls back to headless", async () => {
    const calls: string[] = [];
    const closeBrowser = vi.fn(() => Promise.resolve());
    const selected = await initializeBrowserBackend(config("auto"), {
      createBridge: () => makeBridge(false, calls),
      autoTimeoutMs: 1,
      waitForExtension: () => Promise.resolve(false),
      createExtensionBackend: () => backend("extension"),
      createLaunchBackend: () => {
        calls.push("launch");
        return Promise.resolve(backend("headless", closeBrowser));
      },
    });

    expect(calls).toEqual(["bridge-start", "bridge-close", "launch"]);
    expect(selected.fallbackReason).toMatch(/extension.*unavailable.*startup/i);
    await selected.close();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});
