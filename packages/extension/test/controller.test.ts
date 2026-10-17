import {
  BrowserUseError,
  MAX_WIRE_MESSAGE_BYTES,
  serializeWireMessage,
  type WireMessage,
} from "@browser-use/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeState } from "../src/bridge/client";
import {
  Controller,
  type ControllerDeps,
  type PersistedTab,
  type TabInfo,
} from "../src/controller";

const rid = "11111111-1111-4111-8111-111111111111";

const RESTING: BridgeState[] = ["off", "unpaired", "idle"];

function setup(state: BridgeState = "ready", overrides: Partial<ControllerDeps> = {}) {
  const sent: WireMessage[] = [];
  const bridge = {
    state,
    running: !RESTING.includes(state),
    /** What a connection attempt ends in; undefined leaves the state unchanged. */
    startsAs: undefined as BridgeState | undefined,
    send: vi.fn((m: WireMessage) => sent.push(m)),
    pair: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => {
      bridge.running = true;
      if (bridge.startsAs !== undefined) bridge.state = bridge.startsAs;
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      bridge.running = false;
      bridge.state = "off";
    }),
    waitForReady: vi.fn(() => Promise.resolve(bridge.state)),
  };
  const adapter = {
    attach: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    sendCommand: vi.fn((): Promise<unknown> => Promise.resolve({ value: 1 })),
    reattach: vi.fn((tabIds: readonly number[]) => Promise.resolve([...tabIds])),
  };
  const tabInfo = (id: number): TabInfo => ({
    id,
    url: `https://t${id}/`,
    title: `T${id}`,
    active: true,
    windowId: 1,
  });
  const tabs = {
    get: vi.fn((id: number) => Promise.resolve(tabInfo(id))),
    create: vi.fn(() => Promise.resolve({ id: 50 })),
    remove: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve([tabInfo(7)])),
    update: vi.fn((id: number) => Promise.resolve(tabInfo(id))),
  };
  const addToGroup = vi.fn(() => Promise.resolve());
  const deps: ControllerDeps = {
    bridge,
    adapter,
    tabs,
    isAllowedFileSchemeAccess: () => Promise.resolve(true),
    addToGroup,
    graceMs: 1000,
    ...overrides,
  };
  const controller = new Controller(deps);
  const types = () => sent.map((m) => m.type);
  return { controller, bridge, adapter, tabs, sent, types, deps, addToGroup };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("connect from the popup", () => {
  it("attaches, registers the tab and reports connected", async () => {
    const { controller, adapter, sent } = setup();
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(adapter.attach).toHaveBeenCalledWith(7);
    expect(sent[0]).toMatchObject({
      type: "registerTab",
      tabId: 7,
      url: "https://t7/",
      title: "T7",
    });
    expect(reply).toMatchObject({ state: "connected", connectedCount: 1 });
  });

  it("refuses with NOT_PAIRED when unpaired and attaches nothing", async () => {
    const { controller, adapter } = setup("unpaired");
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(reply.error).toMatch(/pairing code/i);
    expect(adapter.attach).not.toHaveBeenCalled();
  });

  it("refuses when the daemon is unreachable", async () => {
    const { controller, adapter } = setup("backoff");
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(reply.error).toMatch(/not reachable.*MCP client/i);
    expect(adapter.attach).not.toHaveBeenCalled();
  });

  it("detaches and reports an error when attach fails", async () => {
    const { controller, adapter } = setup();
    adapter.attach.mockRejectedValueOnce(new BrowserUseError("INTERNAL", "restricted"));
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(reply).toMatchObject({ state: "error", error: "restricted", connectedCount: 0 });
    expect(adapter.detach).toHaveBeenCalledWith(7);
  });

  it("opens a blank tab instead of attaching to the browser's new-tab page", async () => {
    const { controller, tabs } = setup();
    tabs.query.mockResolvedValueOnce([{ id: 3, url: "chrome://newtab/", windowId: 1 }]);
    await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: "about:blank" }));
  });
});

describe("bridge commands", () => {
  async function connected() {
    const ctx = setup();
    await ctx.controller.onPopupMessage({ type: "connect-active-tab" });
    ctx.sent.length = 0;
    return ctx;
  }

  describe("input commands on background tabs", () => {
    const cmd = (method: string): WireMessage => ({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 7,
      method,
      params: {},
    });

    it("activates an inactive tab before Input.dispatch* commands", async () => {
      const { controller, adapter, tabs } = await connected();
      tabs.get.mockResolvedValueOnce({ ...(await tabs.get(7)), active: false });
      await controller.onBridgeMessage(cmd("Input.dispatchMouseEvent"));
      expect(tabs.update).toHaveBeenCalledWith(7, { active: true });
      expect(tabs.update.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.sendCommand.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("waits for the activated tab to become visible before sending the input", async () => {
      const { controller, adapter, tabs } = await connected();
      tabs.get.mockResolvedValueOnce({ ...(await tabs.get(7)), active: false });
      adapter.sendCommand
        .mockResolvedValueOnce({ result: { value: "hidden" } })
        .mockResolvedValueOnce({ result: { value: "visible" } });
      const done = controller.onBridgeMessage(cmd("Input.dispatchMouseEvent"));
      await vi.advanceTimersByTimeAsync(100);
      await done;
      const methods = adapter.sendCommand.mock.calls.map((call: unknown[]) => call[1]);
      expect(methods).toEqual(["Runtime.evaluate", "Runtime.evaluate", "Input.dispatchMouseEvent"]);
    });

    it("does not update an already active tab", async () => {
      const { controller, adapter, tabs } = await connected();
      await controller.onBridgeMessage(cmd("Input.dispatchKeyEvent"));
      expect(tabs.update).not.toHaveBeenCalled();
      expect(adapter.sendCommand).toHaveBeenCalled();
    });

    it("never activates for non-input commands", async () => {
      const { controller, tabs } = await connected();
      tabs.get.mockResolvedValue({ ...(await tabs.get(7)), active: false });
      await controller.onBridgeMessage(cmd("Runtime.evaluate"));
      expect(tabs.update).not.toHaveBeenCalled();
    });

    it("still sends the command when activation fails", async () => {
      const { controller, adapter, tabs } = await connected();
      tabs.get.mockRejectedValueOnce(new Error("No tab with id"));
      await controller.onBridgeMessage(cmd("Input.dispatchMouseEvent"));
      expect(adapter.sendCommand).toHaveBeenCalled();
    });
  });

  it("runs allowed commands on connected tabs and responds", async () => {
    const { controller, adapter, sent } = await connected();
    await controller.onBridgeMessage({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 7,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    expect(adapter.sendCommand).toHaveBeenCalledWith(7, "Runtime.evaluate", { expression: "1" });
    expect(sent[0]).toEqual({ type: "response", version: 1, requestId: rid, result: { value: 1 } });
  });

  it("answers LIMIT_EXCEEDED when the result is over the 2 MiB bridge limit", async () => {
    const { controller, adapter, bridge, sent } = await connected();
    // Behave like BridgeClient.send: validate, then refuse anything over the wire limit.
    bridge.send.mockImplementation((m: WireMessage) => {
      const text = serializeWireMessage(m);
      if (text.length > MAX_WIRE_MESSAGE_BYTES) {
        throw new BrowserUseError("LIMIT_EXCEEDED", "Bridge message exceeds the 2 MiB limit");
      }
      return sent.push(m);
    });
    adapter.sendCommand.mockResolvedValueOnce({ value: "x".repeat(MAX_WIRE_MESSAGE_BYTES) });
    await controller.onBridgeMessage({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 7,
      method: "Accessibility.getFullAXTree",
      params: {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: rid,
      error: { code: "LIMIT_EXCEEDED", message: expect.stringMatching(/2 MiB/) as string },
    });
  });

  it("answers with a schema-valid error when Chrome's error message is empty", async () => {
    const { controller, adapter, bridge, sent } = await connected();
    bridge.send.mockImplementation((m: WireMessage) => {
      serializeWireMessage(m);
      return sent.push(m);
    });
    adapter.sendCommand.mockRejectedValueOnce(new Error(""));
    await controller.onBridgeMessage({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 7,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "error", requestId: rid, error: { code: "INTERNAL" } });
  });

  it("answers TAB_NOT_CONNECTED for tabs it does not control", async () => {
    const { controller, sent } = await connected();
    await controller.onBridgeMessage({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 99,
      method: "Page.reload",
      params: {},
    });
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: rid,
      error: { code: "TAB_NOT_CONNECTED" },
    });
  });

  it("forwards typed adapter errors and wraps unknown ones as INTERNAL", async () => {
    const { controller, adapter, sent } = await connected();
    adapter.sendCommand.mockRejectedValueOnce(
      new BrowserUseError("UNSUPPORTED_CDP_METHOD", "nope"),
    );
    adapter.sendCommand.mockRejectedValueOnce(new Error("boom"));
    for (const id of [rid, "22222222-2222-4222-8222-222222222222"]) {
      await controller.onBridgeMessage({
        type: "command",
        version: 1,
        requestId: id,
        tabId: 7,
        method: "Page.reload",
        params: {},
      });
    }
    expect(sent[0]).toMatchObject({ error: { code: "UNSUPPORTED_CDP_METHOD" } });
    expect(sent[1]).toMatchObject({ error: { code: "INTERNAL", message: "boom" } });
  });

  it("registers a still-loading new tab with its pending URL (Chrome reports url as an empty string)", async () => {
    const { controller, tabs, sent } = setup();
    tabs.get.mockResolvedValueOnce({
      id: 50,
      url: "",
      pendingUrl: "https://example.com/",
      title: "",
    });
    await controller.onBridgeMessage({
      type: "openTab",
      version: 1,
      requestId: rid,
      url: "https://example.com/",
    });
    expect(sent.find((m) => m.type === "registerTab")).toMatchObject({
      url: "https://example.com/",
    });
  });

  it("opens a tab in the background, auto-connects it, groups it and replies with its id", async () => {
    const { controller, tabs, adapter, sent, addToGroup } = setup();
    await controller.onBridgeMessage({
      type: "openTab",
      version: 1,
      requestId: rid,
      url: "https://example.com/",
    });
    expect(tabs.create).toHaveBeenCalledWith({ url: "https://example.com/", active: false });
    expect(adapter.attach).toHaveBeenCalledWith(50);
    expect(addToGroup).toHaveBeenCalledWith(50);
    expect(sent.find((m) => m.type === "registerTab")).toMatchObject({
      tabId: 50,
      autoConnected: true,
    });
    expect(sent.at(-1)).toEqual({
      type: "response",
      version: 1,
      requestId: rid,
      result: { tabId: 50 },
    });
  });

  it("still succeeds when tab grouping fails", async () => {
    const { controller, sent } = setup("ready", {
      addToGroup: () => Promise.reject(new Error("no tabGroups")),
    });
    await controller.onBridgeMessage({
      type: "openTab",
      version: 1,
      requestId: rid,
      url: "https://example.com/",
    });
    expect(sent.at(-1)).toMatchObject({ type: "response", result: { tabId: 50 } });
  });

  it("closes only connected tabs", async () => {
    const { controller, tabs, sent } = await connected();
    await controller.onBridgeMessage({ type: "closeTab", version: 1, requestId: rid, tabId: 99 });
    expect(sent[0]).toMatchObject({ type: "error", error: { code: "TAB_NOT_CONNECTED" } });
    await controller.onBridgeMessage({ type: "closeTab", version: 1, requestId: rid, tabId: 7 });
    expect(tabs.remove).toHaveBeenCalledWith(7);
  });

  it("reports file access", async () => {
    const { controller, sent } = setup();
    await controller.onBridgeMessage({ type: "fileAccess", version: 1, requestId: rid });
    expect(sent[0]).toEqual({
      type: "response",
      version: 1,
      requestId: rid,
      result: { allowed: true },
    });
  });
});

describe("upkeep", () => {
  it("relays debugger events only for connected tabs", async () => {
    const { controller, sent } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    sent.length = 0;
    controller.onDebuggerEvent(7, "Page.loadEventFired", { timestamp: 1 });
    controller.onDebuggerEvent(8, "Page.loadEventFired", {});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "event", tabId: 7, method: "Page.loadEventFired" });
  });

  it("tells the download tracker only about downloads that connected tabs begin", async () => {
    const expectDownload = vi.fn();
    const { controller } = setup("ready", { downloads: { expect: expectDownload } });
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onDebuggerEvent(8, "Page.downloadWillBegin", { url: "https://other/x" });
    controller.onDebuggerEvent(7, "Page.downloadWillBegin", { url: "https://t7/file.zip" });
    expect(expectDownload).toHaveBeenCalledTimes(1);
    expect(expectDownload).toHaveBeenCalledWith("https://t7/file.zip");
  });

  it("re-registers a tab with its new title on update", async () => {
    const { controller, tabs, sent } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    sent.length = 0;
    tabs.get.mockResolvedValueOnce({
      id: 7,
      url: "https://t7/next",
      title: "New",
      active: true,
      windowId: 1,
    });
    await controller.onTabUpdated(7);
    expect(sent[0]).toMatchObject({
      type: "registerTab",
      tabId: 7,
      title: "New",
      url: "https://t7/next",
    });
  });

  it("unregisters exactly once when the tab closes or Chrome detaches the debugger", async () => {
    const { controller, sent, adapter } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    sent.length = 0;
    controller.onExternalDetach(7);
    controller.onTabRemoved(7);
    expect(sent.filter((m) => m.type === "unregisterTab")).toHaveLength(1);
    expect(adapter.detach).toHaveBeenCalledTimes(1);
  });

  it("disconnect-tab and disconnect-all detach and unregister", async () => {
    const { controller, adapter, sent } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    const reply = await controller.onPopupMessage({ type: "disconnect-tab", tabId: 7 });
    expect(reply).toMatchObject({ state: "disconnected", connectedCount: 0 });
    expect(adapter.detach).toHaveBeenCalledWith(7);
    expect(sent.some((m) => m.type === "unregisterTab")).toBe(true);
    await controller.onPopupMessage({ type: "connect-active-tab" });
    const all = await controller.onPopupMessage({ type: "disconnect-all" });
    expect(all.connectedCount).toBe(0);
  });
});

describe("bridge lifecycle", () => {
  it("re-registers connected tabs when the bridge becomes ready again", async () => {
    const { controller, sent } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    sent.length = 0;
    controller.onBridgeState("backoff");
    controller.onBridgeState("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((m) => m.type === "registerTab")).toHaveLength(1);
  });

  it("cleans up a tab that vanished while the bridge was down", async () => {
    const { controller, tabs, sent, adapter } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onBridgeState("backoff");
    tabs.get.mockRejectedValueOnce(new Error("No tab with id"));
    sent.length = 0;
    controller.onBridgeState("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.detach).toHaveBeenCalledWith(7);
    expect(sent.some((m) => m.type === "unregisterTab")).toBe(true);
  });

  it("detaches everything after the grace period without a bridge, but not if it returns in time", async () => {
    const a = setup();
    await a.controller.onPopupMessage({ type: "connect-active-tab" });
    a.controller.onBridgeState("backoff");
    await vi.advanceTimersByTimeAsync(1001);
    expect(a.adapter.detach).toHaveBeenCalledWith(7);

    const b = setup();
    await b.controller.onPopupMessage({ type: "connect-active-tab" });
    b.controller.onBridgeState("backoff");
    await vi.advanceTimersByTimeAsync(500);
    b.controller.onBridgeState("ready");
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.adapter.detach).not.toHaveBeenCalled();
  });

  it("detaches everything immediately when the token is revoked (unpaired)", async () => {
    const { controller, adapter } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onBridgeState("unpaired");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.detach).toHaveBeenCalledWith(7);
  });
});

describe("pair and status messages", () => {
  it("delegates pair to the bridge and reports errors without throwing", async () => {
    const { controller, bridge } = setup("unpaired");
    const ok = await controller.onPopupMessage({ type: "pair", code: "ABCD-2345" });
    expect(bridge.pair).toHaveBeenCalledWith("ABCD-2345");
    expect(ok.error).toBeUndefined();
    bridge.pair.mockRejectedValueOnce(
      new BrowserUseError("NOT_PAIRED", "Invalid or expired pairing code."),
    );
    const bad = await controller.onPopupMessage({ type: "pair", code: "ZZZZZZZZ" });
    expect(bad.error).toBe("Invalid or expired pairing code.");
  });

  it("get-status reports the bridge state and the asked tab's state", async () => {
    const { controller } = setup("backoff");
    expect(await controller.onPopupMessage({ type: "get-status", tabId: 7 })).toMatchObject({
      bridge: "backoff",
      state: "disconnected",
      connectedCount: 0,
    });
  });
});

describe("service-worker restart", () => {
  function memorySession(initial?: unknown) {
    let stored: unknown = initial;
    const session = {
      load: vi.fn(() => Promise.resolve(stored)),
      save: vi.fn((tabs: PersistedTab[]) => {
        stored = tabs;
        return Promise.resolve();
      }),
    };
    return { session, stored: () => stored };
  }
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("persists connected tabs, agent tabs and open dialogs, and forgets disconnected ones", async () => {
    const { session, stored } = memorySession();
    const { controller } = setup("ready", { session });
    await controller.onPopupMessage({ type: "connect-active-tab" });
    await controller.onBridgeMessage({
      type: "openTab",
      version: 1,
      requestId: rid,
      url: "https://t50/",
    });
    controller.onDebuggerEvent(7, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Sure?",
      url: "https://t7/",
    });
    await settle();
    expect(stored()).toEqual([
      { tabId: 7, auto: false, dialog: { type: "confirm", message: "Sure?", url: "https://t7/" } },
      { tabId: 50, auto: true },
    ]);
    await controller.onPopupMessage({ type: "disconnect-tab", tabId: 7 });
    await settle();
    expect(stored()).toEqual([{ tabId: 50, auto: true }]);
  });

  it("adopts still-attached tabs after a restart and re-registers them when the bridge is ready", async () => {
    const { session } = memorySession([
      { tabId: 7, auto: false, dialog: { type: "alert", message: "open", url: "https://t7/" } },
      { tabId: 8, auto: true },
      { tabId: 9, auto: false },
    ]);
    const restarted = setup("connecting", { session });
    // Tab 9's debugger session did not survive the restart.
    restarted.adapter.reattach.mockResolvedValueOnce([7, 8]);
    await restarted.controller.restore();
    expect(restarted.adapter.reattach).toHaveBeenCalledWith([7, 8, 9]);
    expect(restarted.adapter.attach).not.toHaveBeenCalled();
    restarted.controller.onBridgeState("ready");
    await settle();
    const registered = restarted.sent.filter((m) => m.type === "registerTab");
    expect(registered).toEqual([
      expect.objectContaining({
        tabId: 7,
        pendingDialog: { type: "alert", message: "open", url: "https://t7/" },
      }),
      expect.objectContaining({ tabId: 8, autoConnected: true }),
    ]);
    await restarted.controller.onBridgeMessage({
      type: "command",
      version: 1,
      requestId: rid,
      tabId: 8,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    expect(restarted.sent.at(-1)).toMatchObject({ type: "response", requestId: rid });
    const reply = await restarted.controller.onPopupMessage({ type: "get-status", tabId: 7 });
    expect(reply).toMatchObject({ state: "connected", connectedCount: 2 });
    await settle();
    expect(session.save).toHaveBeenLastCalledWith([
      { tabId: 7, auto: false, dialog: { type: "alert", message: "open", url: "https://t7/" } },
      { tabId: 8, auto: true },
    ]);
  });

  it("does not re-attach after a restart when an adopted tab is reconnected from the popup", async () => {
    const { session } = memorySession([{ tabId: 7, auto: false }]);
    const { controller, adapter } = setup("ready", { session });
    await controller.restore();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(adapter.attach).not.toHaveBeenCalled();
  });

  it("ignores malformed stored state", async () => {
    const { session } = memorySession([{ tabId: "x" }]);
    const { controller, adapter } = setup("ready", { session });
    await controller.restore();
    expect(adapter.reattach).not.toHaveBeenCalled();
  });
});

describe("dialogs across a bridge reconnect", () => {
  it("reports an open dialog in registerTab and drops it once closed", async () => {
    const { controller, sent } = setup();
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onDebuggerEvent(7, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "hi",
      url: "https://t7/",
      hasBrowserHandler: true,
    });
    sent.length = 0;
    controller.onBridgeState("backoff");
    controller.onBridgeState("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find((m) => m.type === "registerTab")).toMatchObject({
      tabId: 7,
      pendingDialog: { type: "alert", message: "hi", url: "https://t7/" },
    });
    controller.onDebuggerEvent(7, "Page.javascriptDialogClosed", { result: true });
    sent.length = 0;
    controller.onBridgeState("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find((m) => m.type === "registerTab")).not.toHaveProperty("pendingDialog");
  });
});

describe("explicit connection model", () => {
  function preferences(initial = false) {
    let value = initial;
    return {
      getAlwaysConnected: vi.fn(() => Promise.resolve(value)),
      setAlwaysConnected: vi.fn((next: boolean) => {
        value = next;
        return Promise.resolve();
      }),
    };
  }

  it("holds no connection at start with no tabs and the setting off", async () => {
    const { controller, bridge } = setup("off", { preferences: preferences(false) });
    await controller.start();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.running).toBe(false);
  });

  it("connects when the first tab is connected from the popup", async () => {
    const { controller, bridge, adapter, sent } = setup("off");
    bridge.startsAs = "ready";
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(bridge.start.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.attach.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sent[0]).toMatchObject({ type: "registerTab", tabId: 7 });
    expect(reply).toMatchObject({ bridge: "ready", state: "connected", connectedCount: 1 });
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it("closes the connection again when Connect cannot reach the daemon", async () => {
    const { controller, bridge, adapter } = setup("off");
    bridge.startsAs = "backoff";
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(reply.error).toMatch(/not reachable/i);
    expect(adapter.attach).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalled();
    expect(bridge.running).toBe(false);
  });

  it("reports another browser on BRIDGE_IN_USE, attaches nothing and lets the socket go", async () => {
    const { controller, bridge, adapter } = setup("off");
    bridge.startsAs = "inUse";
    const reply = await controller.onPopupMessage({ type: "connect-active-tab" });
    expect(reply.error).toMatch(/another browser is connected/i);
    expect(adapter.attach).not.toHaveBeenCalled();
    expect(bridge.running).toBe(false);
  });

  it("disconnects after the last tab goes away, after unregistering it", async () => {
    const { controller, bridge } = setup("off");
    bridge.startsAs = "ready";
    await controller.onPopupMessage({ type: "connect-active-tab" });
    await controller.onBridgeMessage({
      type: "openTab",
      version: 1,
      requestId: rid,
      url: "https://t50/",
    });
    await controller.onPopupMessage({ type: "disconnect-tab", tabId: 7 });
    expect(bridge.stop).not.toHaveBeenCalled();
    controller.onTabRemoved(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    const lastSend = bridge.send.mock.invocationCallOrder.at(-1) ?? 0;
    expect(bridge.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: "unregisterTab", tabId: 50 });
    expect(lastSend).toBeLessThan(bridge.stop.mock.invocationCallOrder[0] ?? 0);
  });

  it("disconnects when Chrome detaches the debugger from the last tab", async () => {
    const { controller, bridge } = setup("off");
    bridge.startsAs = "ready";
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onExternalDetach(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("disconnect-all drops the connection when the setting is off", async () => {
    const { controller, bridge } = setup("off");
    bridge.startsAs = "ready";
    await controller.onPopupMessage({ type: "connect-active-tab" });
    const reply = await controller.onPopupMessage({ type: "disconnect-all" });
    expect(bridge.stop).toHaveBeenCalled();
    expect(reply).toMatchObject({ bridge: "off", connectedCount: 0 });
  });

  it("toggling alwaysConnected on connects and stores it; off disconnects", async () => {
    const prefs = preferences(false);
    const { controller, bridge } = setup("off", { preferences: prefs });
    await controller.start();
    const on = await controller.onPopupMessage({ type: "set-always-connected", value: true });
    expect(on.alwaysConnected).toBe(true);
    expect(prefs.setAlwaysConnected).toHaveBeenCalledWith(true);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    const off = await controller.onPopupMessage({ type: "set-always-connected", value: false });
    expect(off.alwaysConnected).toBe(false);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection when the setting goes off while a tab is connected", async () => {
    const { controller, bridge } = setup("off", { preferences: preferences(true) });
    bridge.startsAs = "ready";
    await controller.start();
    expect(bridge.start).toHaveBeenCalledTimes(1);
    await controller.onPopupMessage({ type: "connect-active-tab" });
    controller.onAlwaysConnectedChanged(false);
    expect(bridge.stop).not.toHaveBeenCalled();
    await controller.onPopupMessage({ type: "disconnect-all" });
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("follows setting changes made outside the popup (storage.onChanged)", () => {
    const { controller, bridge } = setup("off");
    controller.onAlwaysConnectedChanged(true);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    controller.onAlwaysConnectedChanged(true);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    controller.onAlwaysConnectedChanged(false);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("connects at start when the stored setting is on", async () => {
    const { controller, bridge } = setup("off", { preferences: preferences(true) });
    await controller.start();
    expect(bridge.start).toHaveBeenCalledTimes(1);
    const reply = await controller.onPopupMessage({ type: "get-status" });
    expect(reply.alwaysConnected).toBe(true);
  });

  it("connects after a service-worker restart that adopted tabs, and not otherwise", async () => {
    let stored: unknown = [{ tabId: 7, auto: false }];
    const session = {
      load: () => Promise.resolve(stored),
      save: (tabs: PersistedTab[]) => {
        stored = tabs;
        return Promise.resolve();
      },
    };
    const restarted = setup("off", { session });
    await restarted.controller.start();
    expect(restarted.adapter.reattach).toHaveBeenCalledWith([7]);
    expect(restarted.bridge.start).toHaveBeenCalledTimes(1);

    stored = [];
    const empty = setup("off", { session });
    await empty.controller.start();
    expect(empty.bridge.start).not.toHaveBeenCalled();
  });

  it("pairing leaves the connection off unless something wants it", async () => {
    const plain = setup("unpaired");
    await plain.controller.onPopupMessage({ type: "pair", code: "ABCD-2345" });
    expect(plain.bridge.pair).toHaveBeenCalled();
    expect(plain.bridge.start).not.toHaveBeenCalled();

    const keep = setup("unpaired", { preferences: preferences(true) });
    await keep.controller.start();
    keep.bridge.start.mockClear();
    keep.bridge.running = false;
    await keep.controller.onPopupMessage({ type: "pair", code: "ABCD-2345" });
    expect(keep.bridge.start).toHaveBeenCalledTimes(1);
  });
});
