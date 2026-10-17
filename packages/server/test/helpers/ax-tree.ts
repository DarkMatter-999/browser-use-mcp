import type { AxNode } from "../../src/refs/snapshot";

export const n = (
  nodeId: string,
  role: string,
  name: string | undefined,
  extra: Partial<AxNode> = {},
): AxNode => ({
  nodeId,
  role: { value: role },
  ...(name === undefined ? {} : { name: { value: name } }),
  ...extra,
});

export const tree: AxNode[] = [
  n("1", "RootWebArea", "Demo", { childIds: ["2", "3", "4", "5", "6", "8"] }),
  n("2", "heading", "Title", {
    parentId: "1",
    backendDOMNodeId: 20,
    properties: [{ name: "level", value: { value: 1 } }],
    childIds: ["9"],
  }),
  n("3", "button", "Submit", { parentId: "1", backendDOMNodeId: 10 }),
  n("4", "textbox", "Email", { parentId: "1", backendDOMNodeId: 11, value: { value: "a@b.c" } }),
  n("5", "link", "Docs", { parentId: "1", backendDOMNodeId: 12, childIds: ["10"] }),
  n("6", "generic", undefined, { parentId: "1", childIds: ["7"] }),
  n("7", "button", "Nested", { parentId: "6", backendDOMNodeId: 13 }),
  n("8", "button", "Hidden parent", {
    parentId: "1",
    backendDOMNodeId: 14,
    ignored: true,
    childIds: ["11"],
  }),
  n("9", "StaticText", "Title", { parentId: "2" }),
  n("10", "StaticText", "Docs", { parentId: "5" }),
  n("11", "checkbox", "Under ignored", {
    parentId: "8",
    backendDOMNodeId: 15,
    properties: [
      { name: "checked", value: { value: "true" } },
      { name: "disabled", value: { value: true } },
    ],
  }),
];
