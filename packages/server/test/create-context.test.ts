import { describe, expect, it } from "vitest";
import { createToolContext } from "../src/mcp/create-context";
import { NullPointer } from "../src/pointer/null-pointer";
import { OverlayPointer } from "../src/pointer/overlay-pointer";
import { makeContext } from "./helpers/context";

describe("createToolContext", () => {
  it("wires the pointer by flag and gives each context its own RefStore", () => {
    const api = makeContext();
    const on = createToolContext(api, { pointer: true });
    const off = createToolContext(api, { pointer: false });
    expect(on.pointer).toBeInstanceOf(OverlayPointer);
    expect(off.pointer).toBeInstanceOf(NullPointer);
    expect(on.refs).not.toBe(off.refs);
  });

  it("delegates daemon calls", async () => {
    const api = makeContext({ openTab: () => Promise.resolve(9) });
    expect(await createToolContext(api, { pointer: false }).openTab("https://x/")).toBe(9);
  });
});
