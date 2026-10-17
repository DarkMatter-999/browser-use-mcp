import { EventEmitter } from "node:events";
import type { BrowserUseError, ConnectedTab } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BridgeServer } from "../src/daemon/bridge-server";
import { ExtensionBackend } from "../src/daemon/extension-backend";

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

  it("tracks downloads with increasing sequence numbers and notifies", () => {
    const { backend, bridge } = setup();
    const changed = vi.fn();
    backend.onDownloadsChanged(changed);
    const base = { type: "download", version: 1, downloadId: 7, url: "http://x/a", totalBytes: 10 };
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
