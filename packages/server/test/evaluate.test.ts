import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateTools } from "../src/tools/evaluate";
import { findTool, parseText } from "./helpers/tool";
import { scriptedContext } from "./helpers/context";

const tab = [{ tabId: 1, url: "https://a/", title: "A" }];
const ok = (value: unknown) => () => ({ result: { type: "object", value } });

function nested(depth: number): unknown {
  return depth > 0 ? { child: nested(depth - 1) } : "leaf";
}

describe("evaluate", () => {
  it("returns values and sends the required Runtime.evaluate parameters", async () => {
    const ctx = scriptedContext({ "Runtime.evaluate": ok(2) }, tab);
    expect(await evaluate(ctx, { tabId: 1, expression: "1 + 1" })).toEqual({
      value: 2,
      truncated: false,
    });
    expect(ctx.calls[0]?.params).toEqual({
      expression: "1 + 1",
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      timeout: 10_000,
    });
  });

  it("reports a result refused by the bridge size limit as truncated", async () => {
    const ctx = scriptedContext(
      {
        "Runtime.evaluate": () => {
          throw new BrowserUseError("LIMIT_EXCEEDED", "Response exceeds the 2 MiB bridge limit");
        },
      },
      tab,
    );
    expect(await evaluate(ctx, { tabId: 1, expression: "big" })).toMatchObject({
      truncated: true,
    });
  });

  it("represents undefined and unserializable values explicitly", async () => {
    const undef = scriptedContext(
      { "Runtime.evaluate": () => ({ result: { type: "undefined" } }) },
      tab,
    );
    expect(await evaluate(undef, { tabId: 1, expression: "void 0" })).toMatchObject({
      unserializableValue: "undefined",
    });
    const nan = scriptedContext(
      { "Runtime.evaluate": () => ({ result: { type: "number", unserializableValue: "NaN" } }) },
      tab,
    );
    expect(await evaluate(nan, { tabId: 1, expression: "NaN" })).toMatchObject({
      unserializableValue: "NaN",
    });
  });

  it("maps exception details to PAGE_EXCEPTION", async () => {
    const ctx = scriptedContext(
      {
        "Runtime.evaluate": () => ({
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: bad" },
            lineNumber: 2,
            columnNumber: 3,
          },
        }),
      },
      tab,
    );
    await expect(evaluate(ctx, { tabId: 1, expression: "bad()" })).rejects.toMatchObject({
      code: "PAGE_EXCEPTION",
      details: { text: "Uncaught", description: "Error: bad", lineNumber: 2, columnNumber: 3 },
    });
  });

  it("maps a CDP execution timeout to TIMEOUT", async () => {
    const ctx = scriptedContext(
      {
        "Runtime.evaluate": () => ({
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: Script execution timed out." },
          },
        }),
      },
      tab,
    );
    await expect(evaluate(ctx, { tabId: 1, expression: "while(1);" })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("gives the bridge a response grace over the evaluation timeout", async () => {
    let seen = 0;
    const ctx = scriptedContext({ "Runtime.evaluate": ok(1) }, tab);
    const original = ctx.sendCommand.bind(ctx);
    ctx.sendCommand = (tabId, method, params, timeoutMs) => {
      seen = timeoutMs ?? 0;
      return original(tabId, method, params, timeoutMs);
    };
    await evaluate(ctx, { tabId: 1, expression: "1", timeoutMs: 500 });
    expect(seen).toBe(1500);
  });

  it("bounds circular, oversized and deeply nested results", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [circular, "x".repeat(1024 * 1024 + 1), nested(22)]) {
      const ctx = scriptedContext({ "Runtime.evaluate": ok(value) }, tab);
      expect(await evaluate(ctx, { tabId: 1, expression: "v" })).toEqual({
        value: "[Result omitted: serialization limit exceeded]",
        truncated: true,
      });
    }
  });

  it("measures the limit in UTF-8 bytes", async () => {
    const fits = "a".repeat(1024 * 1024 - 2);
    const fitting = scriptedContext({ "Runtime.evaluate": ok(fits) }, tab);
    expect(await evaluate(fitting, { tabId: 1, expression: "v" })).toMatchObject({
      value: fits,
      truncated: false,
    });
    const big = scriptedContext({ "Runtime.evaluate": ok("😀".repeat(262_144)) }, tab);
    expect(await evaluate(big, { tabId: 1, expression: "v" })).toMatchObject({ truncated: true });
  });

  it("requires a connected tab", async () => {
    await expect(
      evaluate(scriptedContext({}, []), { tabId: 9, expression: "1" }),
    ).rejects.toMatchObject({
      code: "TAB_NOT_CONNECTED",
    });
  });
});

describe("evaluate tool", () => {
  const tool = findTool(evaluateTools, "browser_evaluate");

  it("is registered with the not-sandboxed warning", () => {
    expect(tool.description).toContain(
      "Evaluate JavaScript in the page context of a connected tab. **Not sandboxed**: it can read and modify page state and trigger page side effects.",
    );
  });

  it("returns the result as JSON", async () => {
    const ctx = scriptedContext({ "Runtime.evaluate": ok(2) }, tab);
    expect(parseText(await tool.run(ctx, { tabId: 1, expression: "1+1" }))).toMatchObject({
      value: 2,
    });
  });

  it("returns a thrown BrowserUseError as an isError result with its code", async () => {
    const out = await tool.run(scriptedContext({}, []), { tabId: 1, expression: "1" });
    expect(out.isError).toBe(true);
    expect(parseText(out)).toMatchObject({ error: { code: "TAB_NOT_CONNECTED" } });
  });

  it("rejects invalid arguments with INVALID_ARGUMENT", async () => {
    const out = await tool.run(scriptedContext({}, tab), { tabId: -1, expression: "" });
    expect(out.isError).toBe(true);
    expect(parseText(out)).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});
