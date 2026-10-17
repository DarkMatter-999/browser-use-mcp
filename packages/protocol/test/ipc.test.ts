import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserUseError } from "../src/errors";
import {
  type IpcClientMessage,
  type IpcServerMessage,
  parseIpcClientMessage,
  parseIpcServerMessage,
  serializeIpcMessage,
} from "../src/ipc";

const subscriptionId = randomUUID();

const clientSamples = [
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
] satisfies IpcClientMessage[];

const serverSamples = [
  { type: "helloAck", protocolVersion: 1, daemonVersion: "0.1.0" },
  { type: "result", id: 1, value: { paired: true } },
  { type: "failure", id: 2, error: { code: "TIMEOUT", message: "Timed out" } },
  { type: "event", subscriptionId, method: "Page.loadEventFired", params: {} },
  { type: "tabsChanged", tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }] },
  { type: "tabRemoved", subscriptionId, tabId: 7 },
] satisfies IpcServerMessage[];

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
    expect(() => parseIpcClientMessage(JSON.stringify({ type: "shutdown", id: 1 }))).toThrow(
      BrowserUseError,
    );
  });
});
