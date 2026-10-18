import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserUseError, errorPayloadSchema } from "../src/errors";
import {
  browserConfigSchema,
  backendCapabilitiesSchema,
  daemonStatusSchema,
  type IpcClientMessage,
  MAX_IPC_MESSAGE_BYTES,
  type IpcServerMessage,
  parseIpcClientMessage,
  parseIpcServerMessage,
  serializeIpcMessage,
  type BrowserConfig,
} from "../src/ipc";
import { PROTOCOL_VERSION } from "../src/version";

const subscriptionId = randomUUID();
const browserConfig: BrowserConfig = { mode: "extension", profile: "default" };

const clientSamples: IpcClientMessage[] = [
  { type: "hello", protocolVersion: PROTOCOL_VERSION, clientVersion: "0.1.0", browserConfig },
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
  {
    type: "helloAck",
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.1.0",
    effectiveBrowserConfig: { mode: "extension", profile: "default" },
  },
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
    const bad = { ...clientSamples[0], protocolVersion: PROTOCOL_VERSION - 1 };
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
    const text = JSON.stringify({
      type: "helloAck",
      protocolVersion: PROTOCOL_VERSION - 1,
      daemonVersion: "0.1.0",
      effectiveBrowserConfig: { mode: "extension", profile: "default" },
    });
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
    requestedMode: "extension",
    profile: "default",
    capabilities: { cdp: true, downloads: true, dialogs: true, fileAccess: true, pointer: true },
  };

  it("parses a full status", () => {
    expect(daemonStatusSchema.parse(status)).toEqual(status);
  });

  it("rejects mode launch", () => {
    expect(daemonStatusSchema.safeParse({ ...status, mode: "launch" }).success).toBe(false);
  });

  it("parses headless status with configured mode, profile, fallback reason, and capabilities", () => {
    const headlessStatus = {
      ...status,
      mode: "headless",
      requestedMode: "auto",
      profile: "guest",
      browserName: "Chromium",
      fallbackReason: "Extension not connected at startup",
      capabilities: {
        cdp: true,
        downloads: true,
        dialogs: true,
        fileAccess: true,
        pointer: true,
      },
    };
    expect(daemonStatusSchema.parse(headlessStatus)).toEqual(headlessStatus);
  });
});

describe("browser IPC configuration", () => {
  it("validates normalized launch configuration", () => {
    expect(
      browserConfigSchema.parse({
        mode: "auto",
        profile: "guest",
        executablePath: "/usr/bin/chromium",
      }),
    ).toEqual({ mode: "auto", profile: "guest", executablePath: "/usr/bin/chromium" });
    expect(browserConfigSchema.safeParse({ mode: "launch", profile: "default" }).success).toBe(
      false,
    );
  });

  it("validates backend capabilities and configuration mismatch error payloads", () => {
    expect(
      backendCapabilitiesSchema.parse({
        cdp: true,
        downloads: true,
        dialogs: true,
        fileAccess: true,
        pointer: false,
      }),
    ).toEqual({ cdp: true, downloads: true, dialogs: true, fileAccess: true, pointer: false });
    expect(
      errorPayloadSchema.parse({
        code: "CONFIG_MISMATCH",
        message: "The running daemon uses different browser settings",
        hint: "Stop the daemon, then restart with matching MCP config.",
      }).code,
    ).toBe("CONFIG_MISMATCH");
  });
});
