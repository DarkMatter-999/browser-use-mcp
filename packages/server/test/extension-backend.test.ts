import { EventEmitter } from "node:events";
import { PROTOCOL_VERSION, type BrowserUseError, type ConnectedTab } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../src/daemon/bridge-server";
import { ExtensionBackend, MAX_TRACKED_DOWNLOADS } from "../src/daemon/extension-backend";

class FakePeer {
  tabs: ConnectedTab[] = [{ tabId: 1, url: "https://a/", title: "A" }];
  commands: { tabId: number; method: string }[] = [];
  failed: { tabId: number; error: BrowserUseError }[] = [];
  listTabs() {
    return this.tabs;
  }
  sendCommand(tabId: number, method: string) {
    this.commands.push({ tabId, method });
    return Promise.resolve({ ok: true });
  }
  openTab() {
    return Promise.resolve(5);
  }
  closeTab() {
    return Promise.resolve();
  }
  isFileAccessAllowed() {
    return Promise.resolve(true);
  }
  failPendingForTab(tabId: number, error: BrowserUseError) {
    this.failed.push({ tabId, error });
    return 1;
  }
}

function setup() {
  const peer = new FakePeer();
  const bridge = Object.assign(new EventEmitter(), {
    peer,
    requirePeer: () => peer,
  }) as unknown as BridgeServer & EventEmitter;
  const backend = new ExtensionBackend(bridge);
  return { backend, bridge, peer };
}

const opening = { type: "alert", message: "hi", url: "https://a/" };

describe("ExtensionBackend", () => {
  it("does not close the daemon-owned bridge when its backend is closed", async () => {
    const { backend } = setup();

    await expect(backend.close()).resolves.toBeUndefined();

    expect(backend.isConnected()).toBe(true);
  });

  it("browser_open_tab without an extension connection fails with BRIDGE_DISCONNECTED and a hint", async () => {
    const bridge = new BridgeServer({
      port: 1,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      daemonVersion: "1",
      auth: {
        verifyToken: () => false,
        consumePairingCode: () => undefined,
        limiter: { blocked: () => false, record: () => undefined },
      },
    });
    const backend = new ExtensionBackend(bridge);
    await expect(Promise.resolve().then(() => backend.openTab("https://a/"))).rejects.toMatchObject(
      {
        code: "BRIDGE_DISCONNECTED",
        hint: expect.stringMatching(
          /Connect a tab from the Browser Use extension popup.*"Let the agent open tabs"/s,
        ) as string,
      },
    );
  });

  it("passes commands through when no dialog is pending", async () => {
    const { backend, peer } = setup();
    await expect(backend.sendCommand(1, "Runtime.evaluate", {}, 1000)).resolves.toEqual({
      ok: true,
    });
    expect(peer.commands).toEqual([{ tabId: 1, method: "Runtime.evaluate" }]);
  });

  it("blocks commands with DIALOG_OPEN while a dialog is pending, except handleJavaScriptDialog", async () => {
    const { backend, bridge, peer } = setup();
    bridge.emit("tabEvent", 1, "Page.javascriptDialogOpening", opening);
    await expect(backend.sendCommand(1, "Runtime.evaluate", {}, 1000)).rejects.toMatchObject({
      code: "DIALOG_OPEN",
      details: { type: "alert", message: "hi" },
    });
    expect(peer.commands).toEqual([]);
    await backend.sendCommand(1, "Page.handleJavaScriptDialog", { accept: true }, 1000);
    expect(peer.commands).toEqual([{ tabId: 1, method: "Page.handleJavaScriptDialog" }]);
  });

  it("fails in-flight commands for that tab when a dialog opens", () => {
    const { bridge, peer } = setup();
    bridge.emit("tabEvent", 1, "Page.javascriptDialogOpening", opening);
    expect(peer.failed).toHaveLength(1);
    expect(peer.failed[0]).toMatchObject({ tabId: 1, error: { code: "DIALOG_OPEN" } });
  });

  it("seeds dialog state from registerTab after a reconnect and blocks commands", async () => {
    const { backend, bridge, peer } = setup();
    bridge.emit("tabRegistered", 1, opening);
    expect(backend.listTabs()[0]?.pendingDialog).toMatchObject({ type: "alert", message: "hi" });
    await expect(backend.sendCommand(1, "Runtime.evaluate", {}, 1000)).rejects.toMatchObject({
      code: "DIALOG_OPEN",
    });
    expect(peer.commands).toEqual([]);
    bridge.emit("tabRegistered", 1, undefined);
    expect(backend.listTabs()[0]?.pendingDialog).toBeUndefined();
    await expect(backend.sendCommand(1, "Runtime.evaluate", {}, 1000)).resolves.toEqual({
      ok: true,
    });
  });

  it("overlays pendingDialog in listTabs and clears it on close / tab removal", () => {
    const { backend, bridge } = setup();
    bridge.emit("tabEvent", 1, "Page.javascriptDialogOpening", opening);
    expect(backend.listTabs()[0]?.pendingDialog).toMatchObject({ type: "alert" });
    bridge.emit("tabEvent", 1, "Page.javascriptDialogClosed", {});
    expect(backend.listTabs()[0]?.pendingDialog).toBeUndefined();
    bridge.emit("tabEvent", 1, "Page.javascriptDialogOpening", opening);
    bridge.emit("tabRemoved", 1);
    expect(backend.listTabs()[0]?.pendingDialog).toBeUndefined();
  });

  it("notifies tab-changed listeners when a dialog opens and delivers events to tab subscribers", () => {
    const { backend, bridge } = setup();
    const changed = vi.fn();
    const events = vi.fn();
    backend.onTabsChanged(changed);
    backend.subscribe(1, events);
    bridge.emit("tabEvent", 1, "Page.javascriptDialogOpening", opening);
    expect(changed).toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith("Page.javascriptDialogOpening", opening);
  });

  it("stops delivering after unsubscribe", () => {
    const { backend, bridge } = setup();
    const events = vi.fn();
    const stop = backend.subscribe(1, events);
    stop();
    bridge.emit("tabEvent", 1, "Page.loadEventFired", {});
    expect(events).not.toHaveBeenCalled();
  });

  it("forgets the least recently updated downloads beyond the cap", () => {
    const { backend, bridge } = setup();
    const base = {
      type: "download",
      version: PROTOCOL_VERSION,
      url: "http://x/a",
      totalBytes: 1,
      filename: "",
    };
    for (let id = 1; id <= MAX_TRACKED_DOWNLOADS + 5; id++) {
      bridge.emit("download", { ...base, downloadId: id, state: "in_progress", bytesReceived: 0 });
    }
    bridge.emit("download", { ...base, downloadId: 3, state: "complete", bytesReceived: 1 });
    const ids = backend.listDownloads().map((d) => d.downloadId);
    expect(ids).toHaveLength(MAX_TRACKED_DOWNLOADS);
    expect(ids).toContain(3);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(6);
    expect(ids).toContain(7);
    expect(ids.at(-1)).toBe(3);
  });

  it("tracks downloads with increasing sequence numbers and notifies", () => {
    const { backend, bridge } = setup();
    const changed = vi.fn();
    backend.onDownloadsChanged(changed);
    const base = {
      type: "download",
      version: PROTOCOL_VERSION,
      downloadId: 7,
      url: "http://x/a",
      totalBytes: 10,
    };
    bridge.emit("download", { ...base, filename: "", state: "in_progress", bytesReceived: 0 });
    bridge.emit("download", { ...base, filename: "/tmp/a", state: "complete", bytesReceived: 10 });
    const downloads = backend.listDownloads();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({
      downloadId: 7,
      state: "complete",
      filename: "/tmp/a",
      sequence: 2,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("reports removal and connection state", () => {
    const { backend, bridge } = setup();
    const removed = vi.fn();
    backend.onTabRemoved(removed);
    bridge.emit("tabRemoved", 1);
    expect(removed).toHaveBeenCalledWith(1);
    expect(backend.isConnected()).toBe(true);
  });
});
