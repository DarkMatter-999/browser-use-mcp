import { describe, expect, it } from "vitest";
import { snapshotTools } from "../src/tools/snapshot";
import { scriptedContext } from "./helpers/context";
import { findTool } from "./helpers/tool";
import { tree } from "./helpers/ax-tree";

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];

describe("browser_snapshot", () => {
  it("returns header and lines and stores refs", async () => {
    const ctx = scriptedContext({ "Accessibility.getFullAXTree": () => ({ nodes: tree }) }, tabs);
    const out = await findTool(snapshotTools, "browser_snapshot").run(ctx, { tabId: 1 });
    const text = out.content[0]?.type === "text" ? out.content[0].text : "";
    expect(text.startsWith("Page: A (https://a/)")).toBe(true);
    expect(text).toContain('- button "Submit" [ref=e1]');
    expect(ctx.refs.resolve(1, "e1")).toBe(10);
  });

  it("invalidates refs on main-frame navigation", async () => {
    const ctx = scriptedContext({ "Accessibility.getFullAXTree": () => ({ nodes: tree }) }, tabs);
    await findTool(snapshotTools, "browser_snapshot").run(ctx, { tabId: 1 });
    ctx.emit(1, "Page.frameNavigated", { frame: { id: "m", url: "https://a/2" } });
    expect(ctx.refs.has(1)).toBe(false);
  });

  it("rejects an unconnected tab", async () => {
    const ctx = scriptedContext({}, []);
    const out = await findTool(snapshotTools, "browser_snapshot").run(ctx, { tabId: 5 });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({
      text: expect.stringContaining("TAB_NOT_CONNECTED") as string,
    });
  });
});
