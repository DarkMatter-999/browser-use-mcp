import { describe, expect, it } from "vitest";
import {
  CDP_ALLOWLIST,
  isAllowedMethod,
  needsContext,
  type ValidationContext,
  validateParams,
} from "../src/cdp/allowlist";

describe("allowlist", () => {
  it("contains the reference methods", () => {
    for (const method of [
      "Page.navigate",
      "Runtime.evaluate",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Network.getCookies",
      "Tracing.start",
      "IO.read",
    ]) {
      expect(isAllowedMethod(method)).toBe(true);
    }
  });

  it("contains the additions needed for refs, dialogs, upload and the overlay", () => {
    for (const method of [
      "DOM.resolveNode",
      "DOM.scrollIntoViewIfNeeded",
      "Runtime.callFunctionOn",
      "Page.getFrameTree",
      "Page.addScriptToEvaluateOnNewDocument",
      "DOM.setFileInputFiles",
      "Page.setInterceptFileChooserDialog",
    ]) {
      expect(isAllowedMethod(method)).toBe(true);
    }
  });

  it("rejects browser-wide and unknown methods", () => {
    for (const method of [
      "Target.setAutoAttach",
      "Browser.close",
      "Fetch.enable",
      "Debugger.enable",
      "Page.setDownloadBehavior",
      "Storage.getCookies",
      "Network.getAllCookies",
      "",
      "page.navigate",
    ]) {
      expect(isAllowedMethod(method)).toBe(false);
    }
  });

  it("has no duplicates and only Domain.method names", () => {
    expect(new Set(CDP_ALLOWLIST).size).toBe(CDP_ALLOWLIST.length);
    for (const method of CDP_ALLOWLIST) expect(method).toMatch(/^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/);
  });
});

describe("validateParams", () => {
  it("accepts a valid Runtime.evaluate and rejects unknown fields and wrong types", () => {
    expect(
      validateParams("Runtime.evaluate", { expression: "1", returnByValue: true }),
    ).toBeUndefined();
    expect(validateParams("Runtime.evaluate", { expression: 1 })).toMatch(/expression/);
    expect(validateParams("Runtime.evaluate", { expression: "1", surprise: true })).toMatch(
      /Runtime\.evaluate/,
    );
    expect(validateParams("Runtime.evaluate", { expression: "1", timeout: "5" })).toMatch(
      /timeout/,
    );
  });

  it("validates Runtime.callFunctionOn", () => {
    expect(
      validateParams("Runtime.callFunctionOn", {
        functionDeclaration: "function(){}",
        objectId: "1",
      }),
    ).toBeUndefined();
    expect(validateParams("Runtime.callFunctionOn", { objectId: "1" })).toMatch(
      /functionDeclaration/,
    );
    expect(
      validateParams("Runtime.callFunctionOn", {
        functionDeclaration: "x".repeat(100_001),
        objectId: "1",
      }),
    ).toMatch(/100000/);
    expect(
      validateParams("Runtime.callFunctionOn", {
        functionDeclaration: "f",
        objectId: "1",
        arguments: new Array(21).fill({}),
      }),
    ).toMatch(/arguments/);
  });

  it("validates DOM.setFileInputFiles", () => {
    expect(
      validateParams("DOM.setFileInputFiles", { files: ["/tmp/a"], backendNodeId: 4 }),
    ).toBeUndefined();
    expect(validateParams("DOM.setFileInputFiles", { files: [], backendNodeId: 4 })).toMatch(
      /files/,
    );
    expect(validateParams("DOM.setFileInputFiles", { files: ["/tmp/a"] })).toMatch(/nodeId/);
    expect(validateParams("DOM.setFileInputFiles", { files: [1], backendNodeId: 4 })).toMatch(
      /files/,
    );
    expect(
      validateParams("DOM.setFileInputFiles", { files: new Array(21).fill("/a"), nodeId: 1 }),
    ).toMatch(/files/);
  });

  it("validates the new-document script and the chooser toggle", () => {
    expect(
      validateParams("Page.addScriptToEvaluateOnNewDocument", { source: "1" }),
    ).toBeUndefined();
    expect(validateParams("Page.addScriptToEvaluateOnNewDocument", { source: 5 })).toMatch(
      /source/,
    );
    expect(validateParams("Page.setInterceptFileChooserDialog", { enabled: true })).toBeUndefined();
    expect(validateParams("Page.setInterceptFileChooserDialog", { enabled: "yes" })).toMatch(
      /enabled/,
    );
  });

  it("passes methods without a validator", () => {
    expect(validateParams("Page.reload", { ignoreCache: false })).toBeUndefined();
  });
});

const TAB: ValidationContext = { tabUrl: "https://app.example.com/inbox", fileAccess: false };
const FILE_TAB: ValidationContext = { ...TAB, fileAccess: true };

describe("validateParams: URL-scoped methods", () => {
  it("marks the URL-scoped methods and fails closed without a tab context", () => {
    for (const method of [
      "Page.navigate",
      "Network.getCookies",
      "Network.deleteCookies",
      "Storage.setCookies",
      "Storage.clearDataForOrigin",
    ]) {
      expect(needsContext(method)).toBe(true);
    }
    expect(needsContext("Runtime.evaluate")).toBe(false);
    expect(validateParams("Page.navigate", { url: "https://example.com/" })).toMatch(/tab's URL/);
  });

  const navigable: [string, ValidationContext][] = [
    ["https://example.com/", TAB],
    ["http://localhost:8080/a?b#c", TAB],
    ["about:blank", TAB],
    ["file:///tmp/a.html", FILE_TAB],
  ];
  it.each(navigable)("Page.navigate accepts %s", (url, context) => {
    expect(validateParams("Page.navigate", { url }, context)).toBeUndefined();
  });

  const unnavigable: [string, ValidationContext][] = [
    ["javascript:alert(1)", FILE_TAB],
    ["chrome://settings", FILE_TAB],
    ["chrome-extension://abc/popup.html", FILE_TAB],
    ["data:text/html,hi", FILE_TAB],
    ["file:///etc/passwd", TAB],
    ["about:config", FILE_TAB],
    ["not a url", FILE_TAB],
  ];
  it.each(unnavigable)("Page.navigate rejects %s", (url, context) => {
    expect(validateParams("Page.navigate", { url }, context)).toMatch(/Page\.navigate/);
  });

  it("Page.navigate rejects unknown options and non-http referrers", () => {
    expect(validateParams("Page.navigate", { url: "https://a.test/", surprise: 1 }, TAB)).toMatch(
      /surprise/,
    );
    expect(
      validateParams("Page.navigate", { url: "https://a.test/", referrer: "javascript:1" }, TAB),
    ).toMatch(/referrer/);
    expect(validateParams("Page.navigate", {}, TAB)).toMatch(/url/);
  });

  it("Network.getCookies only reads cookies for the tab's site", () => {
    expect(
      validateParams(
        "Network.getCookies",
        { urls: ["https://app.example.com/", "http://example.com/x"] },
        TAB,
      ),
    ).toBeUndefined();
    expect(validateParams("Network.getCookies", { urls: ["https://bank.test/"] }, TAB)).toMatch(
      /connected tab/,
    );
    expect(validateParams("Network.getCookies", { urls: ["https://com/"] }, TAB)).toMatch(
      /connected tab/,
    );
    expect(
      validateParams("Network.getCookies", { urls: ["https://evil-example.com/"] }, TAB),
    ).toMatch(/connected tab/);
    expect(validateParams("Network.getCookies", {}, TAB)).toMatch(/urls/);
    expect(
      validateParams(
        "Network.getCookies",
        { urls: ["https://app.example.com/"] },
        { tabUrl: "about:blank", fileAccess: false },
      ),
    ).toMatch(/connected tab/);
  });

  it("Storage.setCookies and Network.deleteCookies stay within the tab's site", () => {
    const cookie = { name: "a", value: "1", domain: ".example.com", path: "/" };
    expect(validateParams("Storage.setCookies", { cookies: [cookie] }, TAB)).toBeUndefined();
    expect(
      validateParams("Storage.setCookies", { cookies: [{ ...cookie, domain: "bank.test" }] }, TAB),
    ).toMatch(/connected tab/);
    expect(
      validateParams(
        "Storage.setCookies",
        { cookies: [{ name: "a", value: "1", url: "https://bank.test/" }] },
        TAB,
      ),
    ).toMatch(/connected tab/);
    expect(
      validateParams("Storage.setCookies", { cookies: [{ name: "a", value: "1" }] }, TAB),
    ).toMatch(/domain or url/);
    expect(
      validateParams("Network.deleteCookies", { name: "a", domain: "app.example.com" }, TAB),
    ).toBeUndefined();
    expect(
      validateParams("Network.deleteCookies", { name: "a", domain: "other.test" }, TAB),
    ).toMatch(/connected tab/);
    expect(validateParams("Network.deleteCookies", { name: "a" }, TAB)).toMatch(/domain or url/);
  });

  it("Storage.clearDataForOrigin is limited to the tab's origin", () => {
    expect(
      validateParams(
        "Storage.clearDataForOrigin",
        { origin: "https://app.example.com", storageTypes: "all" },
        TAB,
      ),
    ).toBeUndefined();
    expect(
      validateParams(
        "Storage.clearDataForOrigin",
        { origin: "https://bank.test", storageTypes: "all" },
        TAB,
      ),
    ).toMatch(/origin/);
  });
});

describe("validateParams: other methods", () => {
  it("has a validator for every allowlisted method", () => {
    const sample: Record<string, unknown> = {};
    for (const method of CDP_ALLOWLIST) {
      // Every method rejects an unknown field (or a missing required one): proof a validator exists.
      expect(validateParams(method, { __unexpected__: sample }, TAB), method).toBeDefined();
    }
  });

  it("caps the Runtime.evaluate expression", () => {
    expect(validateParams("Runtime.evaluate", { expression: "x".repeat(1_000_001) })).toMatch(
      /expression exceeds/,
    );
  });

  it("accepts the shapes the daemon sends", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["Page.enable", {}],
      ["Page.reload", { ignoreCache: false }],
      [
        "Page.captureScreenshot",
        { format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false },
      ],
      [
        "Page.printToPDF",
        { landscape: false, printBackground: true, transferMode: "ReturnAsStream" },
      ],
      ["Page.handleJavaScriptDialog", { accept: true, promptText: "x" }],
      ["Page.navigateToHistoryEntry", { entryId: 3 }],
      [
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1 },
      ],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 100 }],
      ["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", modifiers: 0 }],
      ["Input.insertText", { text: "hello" }],
      ["DOM.getDocument", { depth: 1, pierce: true }],
      ["DOM.querySelectorAll", { nodeId: 1, selector: "button" }],
      ["DOM.describeNode", { backendNodeId: 7 }],
      ["DOM.getBoxModel", { nodeId: 4 }],
      ["DOM.resolveNode", { backendNodeId: 7 }],
      [
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includePaintOrder: false, includeDOMRects: true },
      ],
      ["Accessibility.getFullAXTree", { frameId: "F1" }],
      [
        "Emulation.setDeviceMetricsOverride",
        { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      ],
      ["Emulation.setGeolocationOverride", { latitude: 1, longitude: 2, accuracy: 1 }],
      ["Emulation.setUserAgentOverride", { userAgent: "" }],
      [
        "Network.emulateNetworkConditions",
        { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      ],
      ["Network.getResponseBody", { requestId: "1.2" }],
      ["Tracing.start", { transferMode: "ReportEvents", bufferUsageReportingInterval: 1000 }],
      ["IO.read", { handle: "h", size: 1024 }],
      ["IO.close", { handle: "h" }],
    ];
    for (const [method, params] of calls)
      expect(validateParams(method, params, TAB), method).toBeUndefined();
  });

  it("rejects wrong types on the generic shapes", () => {
    expect(validateParams("Input.dispatchMouseEvent", { type: "drag", x: 1, y: 1 })).toMatch(
      /type/,
    );
    expect(validateParams("Input.insertText", { text: "x".repeat(100_001) })).toMatch(/text/);
    expect(validateParams("DOM.querySelectorAll", { nodeId: "1", selector: "a" })).toMatch(
      /nodeId/,
    );
    expect(validateParams("IO.read", {})).toMatch(/handle/);
    expect(validateParams("Page.reload", { scriptToEvaluateOnLoad: "x" })).toMatch(
      /scriptToEvaluateOnLoad/,
    );
  });
});
