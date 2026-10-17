import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserUseError } from "../src/errors";
import {
  MAX_WIRE_MESSAGE_BYTES,
  parseWireMessage,
  serializeWireMessage,
  type WireMessage,
} from "../src/wire";

const token = "a".repeat(64);

const samples: WireMessage[] = [
  {
    type: "hello",
    version: 1,
    peerId: randomUUID(),
    token,
    extensionVersion: "0.1.0",
  },
  { type: "helloAck", version: 1, daemonVersion: "0.1.0" },
  { type: "registerTab", version: 1, tabId: 7, url: "https://example.com/", title: "Example" },
  {
    type: "registerTab",
    version: 1,
    tabId: 8,
    url: "about:blank",
    title: "",
    active: true,
    autoConnected: true,
  },
  { type: "unregisterTab", version: 1, tabId: 7, reason: "tab closed" },
  {
    type: "command",
    version: 1,
    requestId: randomUUID(),
    tabId: 7,
    method: "Runtime.evaluate",
    params: { expression: "1+1", returnByValue: true },
  },
  { type: "openTab", version: 1, requestId: randomUUID(), url: "https://example.com/" },
  { type: "closeTab", version: 1, requestId: randomUUID(), tabId: 7 },
  { type: "fileAccess", version: 1, requestId: randomUUID() },
  { type: "response", version: 1, requestId: randomUUID(), result: { tabId: 9 } },
  { type: "event", version: 1, tabId: 7, method: "Page.loadEventFired", params: { timestamp: 1 } },
  {
    type: "error",
    version: 1,
    requestId: randomUUID(),
    error: { code: "TAB_NOT_CONNECTED", message: "Tab 7 is not connected" },
  },
  { type: "ping", version: 1 },
  { type: "pong", version: 1 },
  { type: "pair", version: 1, code: "ABCD2345" },
  { type: "paired", version: 1, token },
  {
    type: "download",
    version: 1,
    downloadId: 3,
    filename: "/home/u/Downloads/a.txt",
    url: "http://127.0.0.1/a.txt",
    state: "complete",
    bytesReceived: 10,
    totalBytes: 10,
  },
  {
    type: "registerTab",
    version: 1,
    tabId: 9,
    url: "https://example.com/",
    title: "T",
    pendingDialog: { type: "beforeunload", message: "Leave?", url: "https://example.com/" },
  },
];

describe("wire messages", () => {
  it.each(samples)("round-trips a $type message", (message) => {
    expect(parseWireMessage(serializeWireMessage(message))).toEqual(message);
  });

  it("rejects a token that is not 64 lowercase hex characters", () => {
    const text = JSON.stringify({ ...samples[0], token: "short" });
    expect(() => parseWireMessage(text)).toThrow(BrowserUseError);
  });

  it("reports a version mismatch with an actionable hint", () => {
    const text = JSON.stringify({ ...samples[1], version: 2 });
    try {
      parseWireMessage(text);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserUseError);
      expect((error as BrowserUseError).code).toBe("VERSION_MISMATCH");
      expect((error as BrowserUseError).hint).toMatch(/same release/);
    }
  });

  it("rejects invalid JSON", () => {
    expect(() => parseWireMessage("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects messages above the size limit", () => {
    const text = JSON.stringify({
      type: "response",
      version: 1,
      requestId: randomUUID(),
      result: "x".repeat(MAX_WIRE_MESSAGE_BYTES),
    });
    expect(() => parseWireMessage(text)).toThrow(/size limit/);
  });

  it("requires a UUID request id and JSON-safe params on commands", () => {
    const base = samples[5];
    expect(() => parseWireMessage(JSON.stringify({ ...base, requestId: "1" }))).toThrow(
      BrowserUseError,
    );
    expect(() => parseWireMessage(JSON.stringify({ ...base, params: "x" }))).toThrow(
      BrowserUseError,
    );
  });

  it.each(["abcd2345", "ABCD2301"])("rejects the pairing code %s", (code) => {
    expect(() => parseWireMessage(JSON.stringify({ type: "pair", version: 1, code }))).toThrow(
      BrowserUseError,
    );
  });

  it("rejects an unknown download state", () => {
    const base = samples.find((m) => m.type === "download");
    expect(() => parseWireMessage(JSON.stringify({ ...base, state: "paused" }))).toThrow(
      BrowserUseError,
    );
  });

  it.each([
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["http://example.com/", true],
    ["https://example.com/", true],
    ["about:blank", true],
  ] as [string, boolean][])("openTab url %s accepted=%s", (url, ok) => {
    const text = JSON.stringify({ type: "openTab", version: 1, requestId: randomUUID(), url });
    if (ok) expect(parseWireMessage(text)).toMatchObject({ url });
    else expect(() => parseWireMessage(text)).toThrow(BrowserUseError);
  });

  it("rejects unknown message types and non-positive tab ids", () => {
    expect(() => parseWireMessage(JSON.stringify({ type: "nope", version: 1 }))).toThrow(
      BrowserUseError,
    );
    expect(() => parseWireMessage(JSON.stringify({ ...samples[4], tabId: 0 }))).toThrow(
      BrowserUseError,
    );
  });
});
