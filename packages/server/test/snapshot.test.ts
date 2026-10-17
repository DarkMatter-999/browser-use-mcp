import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/refs/snapshot";
import { n, tree } from "./helpers/ax-tree";

describe("buildSnapshot", () => {
  it("renders roles, names, attributes and refs in document order", () => {
    const { lines, refs } = buildSnapshot(tree);
    expect(lines).toEqual([
      '- page "Demo"',
      '  - heading "Title" [level=1]',
      '  - button "Submit" [ref=e1]',
      '  - textbox "Email" [filled] [ref=e2]',
      '  - link "Docs" [ref=e3]',
      '  - button "Nested" [ref=e4]',
      '  - checkbox "Under ignored" [checked] [disabled] [ref=e5]',
    ]);
    expect([...refs]).toEqual([
      ["e1", 10],
      ["e2", 11],
      ["e3", 12],
      ["e4", 13],
      ["e5", 15],
    ]);
  });

  it("never prints form values", () => {
    expect(buildSnapshot(tree).lines.join("\n")).not.toContain("a@b.c");
  });

  it("dedupes static text equal to its parent's name but keeps other text", () => {
    const nodes = [
      n("1", "RootWebArea", "P", { childIds: ["2"] }),
      n("2", "paragraph", undefined, { parentId: "1", childIds: ["3"] }),
      n("3", "StaticText", "Plain text", { parentId: "2" }),
    ];
    expect(buildSnapshot(nodes).lines).toContain('  - text "Plain text"');
  });

  it("truncates at maxNodes and reports it", () => {
    const { lines, truncated } = buildSnapshot(tree, { maxNodes: 3 });
    expect(lines).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("continues ref numbering from refStart and indents from baseDepth (iframes)", () => {
    const { lines, nextRef } = buildSnapshot(
      [n("1", "button", "In frame", { backendDOMNodeId: 99 })],
      { refStart: 7, baseDepth: 2 },
    );
    expect(lines).toEqual(['    - button "In frame" [ref=e7]']);
    expect(nextRef).toBe(8);
  });

  it("collapses whitespace and truncates long names to 120 characters", () => {
    const long = `A  B\n${"x".repeat(200)}`;
    const line = buildSnapshot([n("1", "button", long, { backendDOMNodeId: 1 })]).lines[0] ?? "";
    expect(line).toContain('"A B ');
    expect((/"([^"]*)"/.exec(line)?.[1] ?? "").length).toBe(120);
  });

  it("does not assign refs to nodes without a backend node id", () => {
    const { refs, lines } = buildSnapshot([n("1", "button", "Ghost")]);
    expect(refs.size).toBe(0);
    expect(lines[0]).toBe('- button "Ghost"');
  });

  it("copes with a node whose parent is missing (treats it as a root)", () => {
    const { lines } = buildSnapshot([
      n("5", "button", "Orphan", { parentId: "nope", backendDOMNodeId: 3 }),
    ]);
    expect(lines).toEqual(['- button "Orphan" [ref=e1]']);
  });
});
