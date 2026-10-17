import { describe, expect, it } from "vitest";
import { CDP_ALLOWLIST, isAllowedMethod, validateParams } from "../src/cdp/allowlist";

describe("allowlist", () => {
  it("contains the reference methods", () => {
    for (const method of [
      "Page.navigate",
      "Runtime.evaluate",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Storage.getCookies",
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
