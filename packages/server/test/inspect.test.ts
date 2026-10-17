import { describe, expect, it } from "vitest";
import { accessibilitySnapshot, domSnapshot, inspectTools, query } from "../src/tools/inspect";
import { scriptedContext } from "./helpers/context";
import { findTool } from "./helpers/tool";

const tab = [{ tabId: 5, url: "https://a/", title: "A" }];

interface FixtureNode {
  parentIndex: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  backendNodeId: number;
  attributes: string[];
}

const nodes: FixtureNode[] = [
  {
    parentIndex: -1,
    nodeType: 9,
    nodeName: "#document",
    nodeValue: "",
    backendNodeId: 1,
    attributes: [],
  },
  {
    parentIndex: 0,
    nodeType: 1,
    nodeName: "HTML",
    nodeValue: "",
    backendNodeId: 2,
    attributes: [],
  },
  {
    parentIndex: 1,
    nodeType: 1,
    nodeName: "BODY",
    nodeValue: "",
    backendNodeId: 3,
    attributes: [],
  },
  {
    parentIndex: 2,
    nodeType: 3,
    nodeName: "#text",
    nodeValue: "hello",
    backendNodeId: 4,
    attributes: [],
  },
];

function snapshotResponse(list: FixtureNode[]): object {
  return {
    documents: [
      {
        nodes: {
          backendNodeId: list.map((node) => node.backendNodeId),
          parentIndex: list.map((node) => node.parentIndex),
          nodeType: list.map((node) => node.nodeType),
          nodeName: list.map((node) => node.nodeName),
          nodeValue: list.map((node) => node.nodeValue),
          attributes: list.map((node) => node.attributes),
        },
      },
    ],
  };
}

describe("browser inspection tools", () => {
  it("returns stable DOM nodes with cursor and truncation metadata", async () => {
    const ctx = scriptedContext(
      { "DOMSnapshot.captureSnapshot": () => snapshotResponse(nodes) },
      tab,
    );
    const page = await domSnapshot(ctx, { tabId: 5, maxNodes: 2 });
    expect(page.nodes.map((node) => node.nodeName)).toEqual(["#document", "HTML"]);
    expect(page).toMatchObject({ tabId: 5, truncated: true, nextCursor: "2" });
    const depthLimited = await domSnapshot(ctx, { tabId: 5, maxDepth: 1 });
    expect(depthLimited.nodes.map((node) => node.nodeName)).toEqual(["#document", "HTML"]);
    expect(depthLimited).toMatchObject({ truncated: true, nextCursor: null });
  });

  it("resolves DOM snapshot string-table indexes from Chrome CDP", async () => {
    const ctx = scriptedContext(
      {
        "DOMSnapshot.captureSnapshot": () => ({
          strings: [
            "#document",
            "HTML",
            "BODY",
            "#text",
            "",
            "id",
            "fixture-title",
            "Lifecycle fixture",
          ],
          documents: [
            {
              nodes: {
                backendNodeId: [1, 2, 3, 4],
                parentIndex: [-1, 0, 1, 2],
                nodeType: [9, 1, 1, 3],
                nodeName: [0, 1, 2, 3],
                nodeValue: [4, 4, 4, 7],
                attributes: [[], [], [5, 6], []],
              },
            },
          ],
        }),
      },
      tab,
    );
    const snapshot = await domSnapshot(ctx, { tabId: 5 });
    expect(snapshot.nodes.map((node) => node.nodeName)).toEqual([
      "#document",
      "HTML",
      "BODY",
      "#text",
    ]);
    expect(snapshot.nodes[2]?.attributes).toEqual({ id: "fixture-title" });
    expect(snapshot.nodes[3]?.nodeValue).toBe("Lifecycle fixture");
  });

  it("omits the pointer overlay host and its subtree from the DOM snapshot", async () => {
    const withOverlay: FixtureNode[] = [
      ...nodes,
      {
        parentIndex: 2,
        nodeType: 1,
        nodeName: "DIV",
        nodeValue: "",
        backendNodeId: 5,
        attributes: ["data-browser-use-overlay", ""],
      },
      {
        parentIndex: 4,
        nodeType: 1,
        nodeName: "SPAN",
        nodeValue: "",
        backendNodeId: 6,
        attributes: [],
      },
    ];
    const ctx = scriptedContext(
      { "DOMSnapshot.captureSnapshot": () => snapshotResponse(withOverlay) },
      tab,
    );
    const page = await domSnapshot(ctx, { tabId: 5 });
    expect(page.nodes.map((node) => node.nodeName)).toEqual(["#document", "HTML", "BODY", "#text"]);
    expect(page).toMatchObject({ truncated: false, nextCursor: null });
  });

  it("bounds accessibility trees and gives empty pages an empty snapshot", async () => {
    const ctx = scriptedContext(
      {
        "Accessibility.getFullAXTree": () => ({
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" } },
            {
              nodeId: "2",
              parentId: "1",
              role: { value: "paragraph" },
              value: { value: "private accessibility value" },
            },
            { nodeId: "3", parentId: "2", role: { value: "text" } },
          ],
        }),
        "DOMSnapshot.captureSnapshot": () => snapshotResponse([]),
      },
      tab,
    );
    expect(await domSnapshot(ctx, { tabId: 5 })).toMatchObject({
      nodes: [],
      truncated: false,
      nextCursor: null,
    });
    const ax = await accessibilitySnapshot(ctx, { tabId: 5, maxNodes: 2, maxDepth: 1 });
    expect(ax.nodes).toHaveLength(2);
    expect(ax).toMatchObject({ truncated: true, nextCursor: null });
    expect(JSON.stringify(ax)).not.toContain("private accessibility value");
  });

  function queryHandlers(attributes: string[]): Record<string, () => unknown> {
    return {
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelector": () => ({ nodeId: 9 }),
      "DOM.describeNode": () => ({ node: { nodeName: "BUTTON", attributes } }),
      "DOM.getBoxModel": () => ({ model: { content: [1, 2, 11, 2, 11, 12, 1, 12] } }),
      "Runtime.evaluate": () => ({
        result: {
          type: "object",
          value: {
            tag: "BUTTON",
            text: "Save",
            attributes: { type: "button" },
            form: { type: "", name: "", value: "", checked: false, disabled: false },
            rect: { x: 1, y: 2, width: 10, height: 10 },
          },
        },
      }),
    };
  }

  it("queries bounded element metadata, handles no match, and rejects invalid selectors", async () => {
    const ctx = scriptedContext(queryHandlers(["type", "button", "onclick", "alert(1)"]), tab);
    await expect(query(ctx, { tabId: 5, selector: "button" })).resolves.toMatchObject({
      found: true,
      tag: "BUTTON",
      text: "Save",
      box: { x: 1, y: 2, width: 10, height: 10 },
    });
    const missing = scriptedContext(
      { ...queryHandlers([]), "DOM.querySelector": () => ({ nodeId: 0 }) },
      tab,
    );
    await expect(query(missing, { tabId: 5, selector: ".missing" })).resolves.toMatchObject({
      found: false,
    });
    const invalid = scriptedContext(
      {
        ...queryHandlers([]),
        "DOM.querySelector": () => {
          throw new Error("Invalid selector");
        },
      },
      tab,
    );
    await expect(query(invalid, { tabId: 5, selector: "[" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("reports ELEMENT_NOT_FOUND for the pointer overlay host", async () => {
    const ctx = scriptedContext(queryHandlers(["data-browser-use-overlay", ""]), tab);
    await expect(query(ctx, { tabId: 5, selector: "div" })).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
    });
    const output = await findTool(inspectTools, "browser_query").run(ctx, {
      tabId: 5,
      selector: "div",
    });
    expect(output.isError).toBe(true);
    expect(output.content[0]).toMatchObject({ type: "text" });
  });

  it("redacts form values and value-bearing attributes in query results", async () => {
    const handlers = queryHandlers(["type", "text", "value", "sensitive-value", "name", "email"]);
    handlers["Runtime.evaluate"] = () => ({
      result: {
        value: {
          tag: "INPUT",
          text: "",
          attributes: { type: "text", value: "sensitive-value", name: "email" },
          form: {
            type: "text",
            name: "email",
            value: "sensitive-value",
            checked: false,
            disabled: false,
          },
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      },
    });
    const result = await query(scriptedContext(handlers, tab), { tabId: 5, selector: "input" });
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(result).toMatchObject({ form: { value: "[redacted]" } });
  });

  it("describes the accessibility snapshot as a fallback to browser_snapshot", () => {
    expect(findTool(inspectTools, "browser_accessibility_snapshot").description).toContain(
      "For a compact tree with refs usable by click/fill/etc., use browser_snapshot.",
    );
  });
});
