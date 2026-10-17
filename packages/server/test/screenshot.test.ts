import { describe, expect, it } from "vitest";
import { screenshot, screenshotTools } from "../src/tools/screenshot";
import { scriptedContext } from "./helpers/context";
import { findTool, parseText } from "./helpers/tool";

const tab = [{ tabId: 1, url: "https://a/", title: "A" }];
const png = Buffer.from("png-bytes").toString("base64");

describe("screenshot", () => {
  it("returns the captured image with its mime type", async () => {
    const ctx = scriptedContext(
      { "Page.captureScreenshot": (p) => ({ data: png, echoed: p.format }) },
      tab,
    );
    expect(await screenshot(ctx, { tabId: 1 })).toMatchObject({ mimeType: "image/png", data: png });
    expect(await screenshot(ctx, { tabId: 1, format: "jpeg", quality: 60 })).toMatchObject({
      mimeType: "image/jpeg",
    });
    expect(ctx.calls.at(-1)?.params).toMatchObject({ format: "jpeg", quality: 60 });
  });

  it("rejects an empty or oversized image with LIMIT_EXCEEDED", async () => {
    const empty = scriptedContext({ "Page.captureScreenshot": () => ({ data: "" }) }, tab);
    await expect(screenshot(empty, { tabId: 1 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const big = scriptedContext(
      {
        "Page.captureScreenshot": () => ({
          data: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        }),
      },
      tab,
    );
    await expect(screenshot(big, { tabId: 1 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

describe("screenshot tool", () => {
  const tool = findTool(screenshotTools, "browser_screenshot");

  it("is registered and returns an image content block", async () => {
    const ctx = scriptedContext({ "Page.captureScreenshot": () => ({ data: png }) }, tab);
    expect(await tool.run(ctx, { tabId: 1 })).toEqual({
      content: [{ type: "image", data: png, mimeType: "image/png" }],
    });
  });

  it("returns a thrown BrowserUseError as an isError result with its code", async () => {
    const ctx = scriptedContext({ "Page.captureScreenshot": () => ({ data: "" }) }, tab);
    const out = await tool.run(ctx, { tabId: 1 });
    expect(out.isError).toBe(true);
    expect(parseText(out)).toMatchObject({ error: { code: "LIMIT_EXCEEDED" } });
  });
});
