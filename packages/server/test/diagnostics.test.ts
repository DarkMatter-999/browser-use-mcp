import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { DiagnosticEventBuffer } from "../src/diagnostics/event-buffer";
import {
  browserClearDiagnostics,
  browserConsole,
  browserNetwork,
  diagnosticsTools,
} from "../src/tools/diagnostics";
import { scriptedContext } from "./helpers/context";
import { findTool } from "./helpers/tool";

const tab = [{ tabId: 7, url: "https://example.test", title: "test" }];

function diagnosticsContext(responseBody = "body") {
  return scriptedContext(
    {
      "Console.enable": () => ({}),
      "Runtime.enable": () => ({}),
      "Log.enable": () => ({}),
      "Page.enable": () => ({}),
      "Network.enable": () => ({}),
      "Network.getResponseBody": () => ({ body: responseBody, base64Encoded: false }),
    },
    tab,
  );
}

describe("diagnostic event buffer", () => {
  it("bounds events and returns cursor and truncation metadata", () => {
    const buffer = new DiagnosticEventBuffer({ maxItems: 2, maxBytes: 10_000 });
    buffer.push(1, "Runtime.consoleAPICalled", { type: "error", args: [] });
    buffer.push(1, "Network.requestWillBeSent", { requestId: "a" });
    buffer.push(1, "Network.responseReceived", { requestId: "a" });
    expect(buffer.read(1, { limit: 10 })).toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
      cursor: 3,
      truncated: true,
    });
    expect(buffer.read(1, { cursor: 2 }).events).toMatchObject([{ sequence: 3 }]);
    const byteBounded = new DiagnosticEventBuffer({ maxItems: 10, maxBytes: 10 });
    byteBounded.push(1, "Runtime.consoleAPICalled", { message: "x".repeat(20) });
    expect(byteBounded.read(1).events).toEqual([]);
  });
});

describe("diagnostics tools", () => {
  it("isolates tabs, orders cursor reads, redacts Set-Cookie, and captures bodies only by request", async () => {
    const ctx = diagnosticsContext();
    await browserConsole(ctx, { tabId: 7 });
    ctx.emit(7, "Runtime.exceptionThrown", { exceptionDetails: { text: "page error" } });
    ctx.emit(7, "Network.requestWillBeSent", {
      requestId: "r",
      request: { url: "https://example.test" },
    });
    ctx.emit(7, "Network.responseReceived", {
      requestId: "r",
      response: { status: 200, headers: { "Set-Cookie": "secret", "content-type": "text/plain" } },
    });
    const consoleResult = await browserConsole(ctx, { tabId: 7 });
    const noBody = await browserNetwork(ctx, { tabId: 7 });
    expect(consoleResult.events[0]).toMatchObject({ type: "exception", text: "page error" });
    expect(noBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "request", requestId: "r" }),
        expect.objectContaining({
          type: "response",
          requestId: "r",
          headers: { "content-type": "text/plain" },
        }),
      ]),
    );
    expect(JSON.stringify(noBody)).not.toContain("secret");
    expect(ctx.calls.some((call) => call.method === "Network.getResponseBody")).toBe(false);
    const withBody = await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    expect(withBody.events.find((event) => event.type === "response")).toMatchObject({
      body: "body",
    });
    expect(ctx.calls).toContainEqual({
      tabId: 7,
      method: "Network.getResponseBody",
      params: { requestId: "r" },
    });
  });

  it("marks a body refused by the bridge size limit as truncated", async () => {
    const ctx = scriptedContext(
      {
        "Network.enable": () => ({}),
        "Network.getResponseBody": () => {
          throw new BrowserUseError("LIMIT_EXCEEDED", "Response exceeds the 2 MiB bridge limit");
        },
      },
      tab,
    );
    await browserNetwork(ctx, { tabId: 7 });
    ctx.emit(7, "Network.responseReceived", { requestId: "big", response: { status: 200 } });
    const result = await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    expect(result.events.find((event) => event.type === "response")).toMatchObject({
      bodyTruncated: true,
    });
  });

  it("records dialogs as console events that survive the dialog closing", async () => {
    const ctx = diagnosticsContext();
    await browserConsole(ctx, { tabId: 7 });
    ctx.emit(7, "Page.javascriptDialogOpening", {
      message: "Are you sure?",
      type: "confirm",
      url: "https://example.test/page",
    });
    ctx.emit(7, "Page.javascriptDialogClosed", { result: true });
    const result = await browserConsole(ctx, { tabId: 7 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "dialog",
      message: "Are you sure?",
      dialogType: "confirm",
      url: "https://example.test/page",
    });
  });

  it("caps captured response bodies at 1 MiB", async () => {
    const ctx = diagnosticsContext("x".repeat(1024 * 1024 + 1));
    await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    ctx.emit(7, "Network.responseReceived", {
      requestId: "large",
      response: { status: 200, headers: {} },
    });
    const result = await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    expect(result.events[0]).not.toHaveProperty("body");
    expect(result.events[0]).toMatchObject({ bodyTruncated: true });
  });

  it("caps aggregate response bodies and marks omitted bodies truncated", async () => {
    const ctx = diagnosticsContext("x".repeat(700 * 1024));
    await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    for (let index = 0; index < 4; index++) {
      ctx.emit(7, "Network.responseReceived", {
        requestId: `aggregate-${index}`,
        response: { status: 200, headers: {} },
      });
    }
    const result = await browserNetwork(ctx, { tabId: 7, includeBodies: true });
    const responses = result.events.filter((event) => event.type === "response");
    const capturedBytes = responses.reduce(
      (total, event) => total + Buffer.byteLength(typeof event.body === "string" ? event.body : ""),
      0,
    );
    expect(capturedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(responses.filter((event) => typeof event.body === "string")).toHaveLength(2);
    expect(responses.slice(2)).toEqual([
      expect.objectContaining({ bodyTruncated: true }),
      expect.objectContaining({ bodyTruncated: true }),
    ]);
  });

  it("clears buffered state on tab disconnect", async () => {
    const ctx = diagnosticsContext();
    await browserConsole(ctx, { tabId: 7 });
    ctx.emit(7, "Runtime.consoleAPICalled", { type: "error", args: [] });
    ctx.removeTab(7);
    await expect(browserConsole(ctx, { tabId: 7 })).rejects.toMatchObject({
      code: "TAB_NOT_CONNECTED",
    });
    expect(await browserClearDiagnostics(ctx, { tabId: 7 })).toMatchObject({ cleared: true });
  });

  it("maps unsupported CDP domains to UNSUPPORTED_CDP_METHOD", async () => {
    const ctx = scriptedContext(
      {
        "Console.enable": () => {
          throw new Error("UNSUPPORTED_CDP_METHOD: Console.enable");
        },
      },
      tab,
    );
    await expect(browserConsole(ctx, { tabId: 7 })).rejects.toMatchObject({
      code: "UNSUPPORTED_CDP_METHOD",
    });
  });

  it("exposes the console, network, and clear tools", () => {
    expect(diagnosticsTools.map((t) => t.name)).toEqual([
      "browser_console",
      "browser_network",
      "browser_clear_diagnostics",
    ]);
    expect(findTool(diagnosticsTools, "browser_console").title).toBeTruthy();
  });
});
