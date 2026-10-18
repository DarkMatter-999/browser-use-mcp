import { randomUUID } from "node:crypto";
import { BrowserUseError, PROTOCOL_VERSION } from "@browser-use/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionPeer, type PeerEvents } from "../src/daemon/extension-peer";
import { FailureLimiter, PairingCodes } from "../src/daemon/token-store";
import { FakeSocket } from "./helpers/fake-socket";

const TOKEN = "c".repeat(64);
const hello = () => ({
  type: "hello",
  version: PROTOCOL_VERSION,
  peerId: randomUUID(),
  token: TOKEN,
  extensionVersion: "0.0.0",
});

function setup(lines: string[] = []) {
  const socket = new FakeSocket();
  const log = {
    info: (line: string) => {
      lines.push(`INFO ${line}`);
      return Promise.resolve();
    },
    error: (line: string) => {
      lines.push(`ERROR ${line}`);
      return Promise.resolve();
    },
  };
  const codes = new PairingCodes();
  const limiter = new FailureLimiter(3, 60_000);
  const events = {
    onReady: vi.fn(),
    onClose: vi.fn(),
    onTabsChanged: vi.fn(),
    onTabRegistered: vi.fn(),
    onTabRemoved: vi.fn(),
    onTabEvent: vi.fn(),
    onDownload: vi.fn(),
  } satisfies PeerEvents;
  const peer = new ExtensionPeer(
    socket,
    {
      verifyToken: (token) => token === TOKEN,
      consumePairingCode: (code) => (codes.consume(code) ? TOKEN : undefined),
      limiter,
    },
    events,
    "9.9.9",
    { log, label: "peer :1234" },
  );
  return { socket, peer, codes, events, limiter, lines };
}

function ready() {
  const ctx = setup();
  ctx.socket.receive(hello());
  return Promise.resolve(ctx);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("handshake", () => {
  it("accepts a valid token, acks with the daemon version and reports ready", async () => {
    const { socket, peer, events } = await ready();
    expect(peer.isReady).toBe(true);
    expect(socket.last()).toMatchObject({ type: "helloAck", daemonVersion: "9.9.9" });
    expect(events.onReady).toHaveBeenCalledWith(peer);
  });

  it("denies a wrong token with NOT_PAIRED and closes 1008", () => {
    const { socket, peer } = setup();
    socket.receive({ ...hello(), token: "d".repeat(64) });
    expect(peer.isReady).toBe(false);
    expect(socket.last()).toMatchObject({ type: "error", error: { code: "NOT_PAIRED" } });
    expect(socket.closeCode).toBe(1008);
  });

  it("exchanges a valid pairing code for the token, then accepts hello", () => {
    const { socket, peer, codes } = setup();
    const code = codes.create();
    socket.receive({ type: "pair", version: PROTOCOL_VERSION, code });
    expect(socket.last()).toEqual({ type: "paired", version: PROTOCOL_VERSION, token: TOKEN });
    expect(peer.isReady).toBe(false);
    socket.receive(hello());
    expect(peer.isReady).toBe(true);
  });

  it("denies an unknown pairing code without NOT_PAIRED (which would erase a stored token)", () => {
    const { socket } = setup();
    socket.receive({ type: "pair", version: PROTOCOL_VERSION, code: "ABCDEFGH" });
    expect(socket.last()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(socket.closeCode).toBe(1008);
  });

  it("still accepts a valid token while pairing is throttled", () => {
    const { socket, peer, limiter } = setup();
    for (let index = 0; index < 3; index += 1) limiter.record();
    expect(limiter.blocked()).toBe(true);
    socket.receive(hello());
    expect(peer.isReady).toBe(true);
  });

  it("answers a throttled pair attempt with LIMIT_EXCEEDED, not NOT_PAIRED", () => {
    const { socket, codes, limiter } = setup();
    const code = codes.create();
    for (let index = 0; index < 3; index += 1) limiter.record();
    socket.receive({ type: "pair", version: PROTOCOL_VERSION, code });
    expect(socket.last()).toMatchObject({ type: "error", error: { code: "LIMIT_EXCEEDED" } });
    expect(socket.closeCode).toBe(1008);
  });

  it("does not let bad hellos throttle anything", () => {
    const { limiter } = setup();
    for (let index = 0; index < 10; index += 1) {
      const { socket } = setup();
      socket.receive({ ...hello(), token: "d".repeat(64) });
    }
    expect(limiter.blocked()).toBe(false);
    const { socket, peer } = setup();
    socket.receive(hello());
    expect(peer.isReady).toBe(true);
    expect(socket.last()).toMatchObject({ type: "helloAck" });
  });

  it("logs denials and malformed messages without the token or pairing code", () => {
    const lines: string[] = [];
    const bad = setup(lines);
    bad.socket.receive({ ...hello(), token: "d".repeat(64) });
    const pair = setup(lines);
    pair.socket.receive({ type: "pair", version: PROTOCOL_VERSION, code: "ZZZZ2222" });
    const malformed = setup(lines);
    malformed.socket.receive({ type: "hello", version: PROTOCOL_VERSION, token: "e".repeat(64) });
    const early = setup(lines);
    early.socket.receive({ type: "ping", version: PROTOCOL_VERSION });
    expect(lines).toEqual([
      expect.stringMatching(/^ERROR peer :1234: handshake denied \(NOT_PAIRED\)/),
      expect.stringMatching(/^ERROR peer :1234: handshake denied \(INVALID_ARGUMENT\)/),
      expect.stringMatching(/^ERROR peer :1234: protocol error, closing: Invalid bridge message/),
      expect.stringMatching(/^ERROR peer :1234: protocol error, closing: Expected hello or pair/),
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain("d".repeat(64));
    expect(text).not.toContain("e".repeat(64));
    expect(text).not.toContain("ZZZZ2222");
  });

  it("closes with 1002 when anything other than pair/hello arrives first", () => {
    const { socket } = setup();
    socket.receive({ type: "ping", version: PROTOCOL_VERSION });
    expect(socket.closeCode).toBe(1002);
  });

  it("closes on an invalid message and reports VERSION_MISMATCH distinctly", () => {
    const { socket } = setup();
    socket.receive({ ...hello(), version: PROTOCOL_VERSION - 1 });
    expect(socket.last()).toMatchObject({ error: { code: "VERSION_MISMATCH" } });
    expect(socket.closeCode).toBe(1002);
  });

  it("refuses a valid hello with BRIDGE_IN_USE when not admitted, without throttling", () => {
    const { socket, peer, events, limiter } = setup();
    const admit = vi.fn(() => false);
    Object.assign(events, { admit });
    socket.receive(hello());
    expect(admit).toHaveBeenCalledWith(peer);
    expect(peer.isReady).toBe(false);
    expect(events.onReady).not.toHaveBeenCalled();
    expect(socket.last()).toMatchObject({ type: "error", error: { code: "BRIDGE_IN_USE" } });
    expect(socket.closeCode).toBe(1008);
    expect(limiter.blocked()).toBe(false);
  });

  it("tracks how long the ready extension has been silent", async () => {
    const { socket, peer } = await ready();
    vi.advanceTimersByTime(25_000);
    expect(peer.silentForMs).toBeGreaterThanOrEqual(25_000);
    socket.receive({ type: "ping", version: PROTOCOL_VERSION });
    expect(peer.silentForMs).toBe(0);
  });

  it("closes the socket with TIMEOUT if the handshake does not finish in 10 s", () => {
    const { socket } = setup();
    vi.advanceTimersByTime(10_001);
    expect(socket.closeCode).toBe(1008);
    expect(socket.last()).toMatchObject({ type: "error", error: { code: "TIMEOUT" } });
  });
});

describe("after handshake", () => {
  it("answers ping with pong", async () => {
    const { socket } = await ready();
    socket.receive({ type: "ping", version: PROTOCOL_VERSION });
    expect(socket.last()).toEqual({ type: "pong", version: PROTOCOL_VERSION });
  });

  it("closes an idle peer after 90 s without messages", async () => {
    const { socket } = await ready();
    vi.advanceTimersByTime(90_001);
    expect(socket.closeCode).toBe(1001);
  });

  it("reports a registered tab's pending dialog to the backend instead of storing it", async () => {
    const { socket, peer, events } = await ready();
    const dialog = { type: "alert", message: "still open", url: "https://a/" };
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 9,
      url: "https://a/",
      title: "A",
      pendingDialog: dialog,
    });
    expect(events.onTabRegistered).toHaveBeenCalledWith(9, dialog);
    expect(peer.listTabs()[0]).not.toHaveProperty("pendingDialog");
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 9,
      url: "https://a/",
      title: "A",
    });
    expect(events.onTabRegistered).toHaveBeenLastCalledWith(9, undefined);
  });

  it("tracks tabs, updates titles on re-register, and keeps them sorted", async () => {
    const { socket, peer, events } = await ready();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 9,
      url: "https://a/",
      title: "A",
    });
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 3,
      url: "https://b/",
      title: "B",
    });
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 9,
      url: "https://a/",
      title: "A2",
    });
    expect(peer.listTabs().map((tab) => [tab.tabId, tab.title])).toEqual([
      [3, "B"],
      [9, "A2"],
    ]);
    expect(events.onTabsChanged).toHaveBeenCalledTimes(3);
  });

  it("unregisters a tab and notifies", async () => {
    const { socket, peer, events } = await ready();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 4,
      url: "https://a/",
      title: "A",
    });
    socket.receive({ type: "unregisterTab", version: PROTOCOL_VERSION, tabId: 4 });
    expect(peer.hasTab(4)).toBe(false);
    expect(events.onTabRemoved).toHaveBeenCalledWith(4);
  });

  it("forwards events only for registered tabs and tracks main-frame URL changes", async () => {
    const { socket, peer, events } = await ready();
    socket.receive({
      type: "event",
      version: PROTOCOL_VERSION,
      tabId: 5,
      method: "Page.loadEventFired",
      params: {},
    });
    expect(events.onTabEvent).not.toHaveBeenCalled();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 5,
      url: "https://a/",
      title: "A",
    });
    socket.receive({
      type: "event",
      version: PROTOCOL_VERSION,
      tabId: 5,
      method: "Page.frameNavigated",
      params: { frame: { id: "f", url: "https://a/next" } },
    });
    socket.receive({
      type: "event",
      version: PROTOCOL_VERSION,
      tabId: 5,
      method: "Page.frameNavigated",
      params: { frame: { id: "g", parentId: "f", url: "https://iframe/" } },
    });
    expect(peer.listTabs()[0]?.url).toBe("https://a/next");
    expect(events.onTabEvent).toHaveBeenCalledTimes(2);
  });

  it("forwards download messages", async () => {
    const { socket, events } = await ready();
    socket.receive({
      type: "download",
      version: PROTOCOL_VERSION,
      downloadId: 1,
      filename: "/tmp/a",
      url: "http://x/a",
      state: "complete",
      bytesReceived: 1,
      totalBytes: 1,
    });
    expect(events.onDownload).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 1 }));
  });

  it("correlates command responses and rejects error responses with the extension's code", async () => {
    const { socket, peer } = await ready();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 6,
      url: "https://a/",
      title: "A",
    });
    const ok = peer.sendCommand(6, "Runtime.evaluate", { expression: "1" }, 1000);
    const sent = socket.last() as { requestId: string; method: string };
    expect(sent.method).toBe("Runtime.evaluate");
    socket.receive({
      type: "response",
      version: PROTOCOL_VERSION,
      requestId: sent.requestId,
      result: { value: 1 },
    });
    await expect(ok).resolves.toEqual({ value: 1 });

    const bad = peer.sendCommand(6, "Nope.nope", {}, 1000);
    const badSent = socket.last() as { requestId: string };
    socket.receive({
      type: "error",
      version: PROTOCOL_VERSION,
      requestId: badSent.requestId,
      error: { code: "UNSUPPORTED_CDP_METHOD", message: "no" },
    });
    await expect(bad).rejects.toMatchObject({ code: "UNSUPPORTED_CDP_METHOD" });
  });

  it("rejects commands for unregistered tabs with TAB_NOT_CONNECTED", async () => {
    const { peer } = await ready();
    expect(() => peer.sendCommand(99, "Runtime.evaluate", {}, 1000)).toThrow(
      expect.objectContaining({ code: "TAB_NOT_CONNECTED" }),
    );
  });

  it("opens a tab and returns the id; rejects malformed results", async () => {
    const { socket, peer } = await ready();
    const opened = peer.openTab("https://example.com/");
    const sent = socket.last() as { type: string; requestId: string };
    expect(sent.type).toBe("openTab");
    socket.receive({
      type: "response",
      version: PROTOCOL_VERSION,
      requestId: sent.requestId,
      result: { tabId: 12 },
    });
    await expect(opened).resolves.toBe(12);

    const bad = peer.openTab("https://example.com/");
    const badSent = socket.last() as { requestId: string };
    socket.receive({
      type: "response",
      version: PROTOCOL_VERSION,
      requestId: badSent.requestId,
      result: { tabId: "x" },
    });
    await expect(bad).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("failPendingForTab only fails that tab's requests", async () => {
    const { socket, peer } = await ready();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 1,
      url: "https://a/",
      title: "A",
    });
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 2,
      url: "https://b/",
      title: "B",
    });
    const one = peer.sendCommand(1, "Runtime.evaluate", {}, 1000);
    const two = peer.sendCommand(2, "Runtime.evaluate", {}, 1000);
    const oneFailed = expect(one).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    expect(peer.failPendingForTab(1, new BrowserUseError("DIALOG_OPEN", "open"))).toBe(1);
    await oneFailed;
    expect(peer.pendingRequestCount).toBe(1);
    const sent = socket.last() as { requestId: string };
    socket.receive({
      type: "response",
      version: PROTOCOL_VERSION,
      requestId: sent.requestId,
      result: 1,
    });
    await expect(two).resolves.toBe(1);
  });

  it("on socket close rejects pending requests, removes tabs, and reports close", async () => {
    const { socket, peer, events } = await ready();
    socket.receive({
      type: "registerTab",
      version: PROTOCOL_VERSION,
      tabId: 1,
      url: "https://a/",
      title: "A",
    });
    const pending = peer.sendCommand(1, "Runtime.evaluate", {}, 1000);
    const failed = expect(pending).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
    socket.close();
    await failed;
    expect(events.onTabRemoved).toHaveBeenCalledWith(1);
    expect(events.onClose).toHaveBeenCalledWith(peer);
    expect(peer.isReady).toBe(false);
  });
});
