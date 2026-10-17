import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserUseError } from "../src/errors";
import {
  daemonStatusSchema,
  type IpcClientMessage,
  MAX_IPC_MESSAGE_BYTES,
  type IpcServerMessage,
  parseIpcClientMessage,
  parseIpcServerMessage,
  serializeIpcMessage,
} from "../src/ipc";

const subscriptionId = randomUUID();

const clientSamples: IpcClientMessage[] = [
  { type: "hello", protocolVersion: 1, clientVersion: "0.1.0" },
  { type: "status", id: 1 },
  { type: "listTabs", id: 2 },
  { type: "openTab", id: 3, url: "https://example.com/" },
  { type: "closeTab", id: 4, tabId: 7 },
  {
    type: "sendCommand",
    id: 5,
    tabId: 7,
    method: "Runtime.evaluate",
    params: { expression: "1" },
    timeoutMs: 5000,
  },
  { type: "subscribe", subscriptionId, tabId: 7 },
  { type: "subscribeRemoval", subscriptionId },
  { type: "unsubscribe", subscriptionId },
  { type: "createPairingCode", id: 6 },
  { type: "resetToken", id: 7 },
  { type: "shutdown", id: 8 },
  { type: "listDownloads", id: 9 },
  { type: "fileAccess", id: 10 },
];

const serverSamples: IpcServerMessage[] = [
  { type: "helloAck", protocolVersion: 1, daemonVersion: "0.1.0" },
  { type: "result", id: 1, value: { paired: true } },
  { type: "failure", id: 2, error: { code: "TIMEOUT", message: "Timed out" } },
  { type: "event", subscriptionId, method: "Page.loadEventFired", params: {} },
  { type: "tabsChanged", tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }] },
  { type: "tabRemoved", subscriptionId, tabId: 7 },
  {
    type: "downloadsChanged",
    downloads: [
      {
        downloadId: 1,
        filename: "/tmp/a",
        url: "http://127.0.0.1/a",
        state: "in_progress",
        bytesReceived: 0,
        totalBytes: 5,
        sequence: 1,
      },
    ],
  },
];

describe("IPC messages", () => {
  it.each(clientSamples)("round-trips client $type", (message) => {
    const line = serializeIpcMessage(message);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseIpcClientMessage(line.trimEnd())).toEqual(message);
  });

  it.each(serverSamples)("round-trips server $type", (message) => {
    expect(parseIpcServerMessage(serializeIpcMessage(message).trimEnd())).toEqual(message);
  });

  it("rejects an out-of-range sendCommand timeout", () => {
    const bad = { ...clientSamples[5], timeoutMs: 300_001 };
    expect(() => parseIpcClientMessage(JSON.stringify(bad))).toThrow(BrowserUseError);
  });

  it("reports a protocol version mismatch on hello", () => {
    const bad = { ...clientSamples[0], protocolVersion: 2 };
    try {
      parseIpcClientMessage(JSON.stringify(bad));
      expect.unreachable();
    } catch (error) {
      expect((error as BrowserUseError).code).toBe("VERSION_MISMATCH");
    }
  });

  it("rejects a client message type the daemon does not know", () => {
    expect(() => parseIpcClientMessage(JSON.stringify({ type: "bogus", id: 1 }))).toThrow(
      BrowserUseError,
    );
  });

  it("reports a version mismatch on a helloAck from the daemon", () => {
    const text = JSON.stringify({ type: "helloAck", protocolVersion: 2, daemonVersion: "0.1.0" });
    try {
      parseIpcServerMessage(text);
      expect.unreachable();
    } catch (error) {
      expect((error as BrowserUseError).code).toBe("VERSION_MISMATCH");
    }
  });

  it("rejects a zero sendCommand timeout", () => {
    const bad = { ...clientSamples[5], timeoutMs: 0 };
    expect(() => parseIpcClientMessage(JSON.stringify(bad))).toThrow(BrowserUseError);
  });

  it("rejects messages above the size limit", () => {
    const text = JSON.stringify({
      type: "result",
      id: 1,
      value: "x".repeat(MAX_IPC_MESSAGE_BYTES),
    });
    expect(() => parseIpcServerMessage(text)).toThrow(/size limit/);
  });

  it.each([
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["http://example.com/", true],
    ["https://example.com/", true],
    ["about:blank", true],
  ] as [string, boolean][])("openTab url %s accepted=%s", (url, ok) => {
    const text = JSON.stringify({ type: "openTab", id: 1, url });
    if (ok) expect(parseIpcClientMessage(text)).toMatchObject({ url });
    else expect(() => parseIpcClientMessage(text)).toThrow(BrowserUseError);
  });
});

describe("daemonStatusSchema", () => {
  const status = {
    daemonVersion: "0.1.0",
    pid: 123,
    port: 9222,
    paired: true,
    extensionConnected: false,
    tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
    mode: "extension",
  };

  it("parses a full status", () => {
    expect(daemonStatusSchema.parse(status)).toEqual(status);
  });

  it("rejects mode launch", () => {
    expect(daemonStatusSchema.safeParse({ ...status, mode: "launch" }).success).toBe(false);
  });
});
