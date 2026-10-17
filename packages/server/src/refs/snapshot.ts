export interface AxValue {
  value?: unknown;
}

export interface AxProperty {
  name: string;
  value?: AxValue;
}

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  backendDOMNodeId?: number;
}

export interface SnapshotOptions {
  maxNodes?: number;
  refStart?: number;
  baseDepth?: number;
}

export interface SnapshotResult {
  lines: string[];
  refs: Map<string, number>;
  truncated: boolean;
  nextRef: number;
}

const SKIPPED_ROLES = new Set(["none", "presentation", "generic", "InlineTextBox", "LineBreak"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "treeitem",
]);
const MAX_NAME = 120;

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function prop(node: AxNode, key: string): unknown {
  return node.properties?.find((p) => p.name === key)?.value?.value;
}

const isTrue = (v: unknown): boolean => v === true || v === "true";

function renderAttributes(node: AxNode, role: string): string[] {
  const attrs: string[] = [];
  const level = prop(node, "level");
  if (role === "heading" && typeof level === "number") attrs.push(`level=${level}`);
  const checked = prop(node, "checked");
  if (isTrue(checked)) attrs.push("checked");
  else if (checked === "mixed") attrs.push("checked=mixed");
  if (isTrue(prop(node, "disabled"))) attrs.push("disabled");
  const expanded = prop(node, "expanded");
  if (typeof expanded === "boolean" || expanded === "true" || expanded === "false") {
    attrs.push(`expanded=${String(isTrue(expanded))}`);
  }
  if (isTrue(prop(node, "selected"))) attrs.push("selected");
  if (isTrue(prop(node, "required"))) attrs.push("required");
  const value = node.value?.value;
  if (
    role === "textbox" &&
    value !== undefined &&
    value !== null &&
    typeof value === "string" &&
    value !== ""
  ) {
    attrs.push("filled");
  }
  return attrs;
}

function refEligible(node: AxNode, role: string): boolean {
  return (
    node.backendDOMNodeId !== undefined &&
    (INTERACTIVE_ROLES.has(role) || isTrue(prop(node, "focusable")))
  );
}

export function buildSnapshot(nodes: AxNode[], options: SnapshotOptions = {}): SnapshotResult {
  const maxNodes = options.maxNodes ?? 400;
  const baseDepth = options.baseDepth ?? 0;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenOf = new Map<string, AxNode[]>();
  for (const node of nodes) {
    if (node.parentId !== undefined && byId.has(node.parentId)) {
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node);
      childrenOf.set(node.parentId, list);
    }
  }
  const childrenFor = (node: AxNode): AxNode[] =>
    node.childIds
      ? node.childIds.flatMap((id) => byId.get(id) ?? [])
      : (childrenOf.get(node.nodeId) ?? []);

  const lines: string[] = [];
  const refs = new Map<string, number>();
  const seen = new Set<string>();
  let nextRef = options.refStart ?? 1;
  let truncated = false;

  const render = (node: AxNode, depth: number, parentName: string): string | undefined => {
    const rawRole = typeof node.role?.value === "string" ? node.role.value : "";
    if (!isEmitted(node, parentName)) return undefined;
    const name = cleanName(node.name?.value);
    const role = rawRole === "RootWebArea" ? "page" : rawRole === "StaticText" ? "text" : rawRole;
    const parts = [`${"  ".repeat(depth)}- ${role}`];
    if (name !== "") parts.push(`"${name}"`);
    for (const attr of renderAttributes(node, rawRole)) parts.push(`[${attr}]`);
    if (refEligible(node, rawRole)) {
      const ref = `e${nextRef++}`;
      if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
      parts.push(`[ref=${ref}]`);
    }
    return parts.join(" ");
  };

  const isEmitted = (node: AxNode, parentName: string): boolean => {
    const role = node.role?.value;
    if (node.ignored || typeof role !== "string" || role === "" || SKIPPED_ROLES.has(role)) {
      return false;
    }
    const name = cleanName(node.name?.value);
    if (role === "StaticText") return name !== "" && name !== parentName;
    return !(role === "paragraph" && name === "");
  };

  const visit = (node: AxNode, depth: number, parentName: string): void => {
    if (truncated || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const emit = isEmitted(node, parentName);
    if (emit) {
      if (lines.length >= maxNodes) {
        truncated = true;
        return;
      }
      const line = render(node, depth, parentName);
      if (line !== undefined) lines.push(line);
    }
    const ownName = emit ? cleanName(node.name?.value) : parentName;
    for (const child of childrenFor(node)) visit(child, depth + (emit ? 1 : 0), ownName);
  };

  for (const node of nodes) {
    if (node.parentId === undefined || !byId.has(node.parentId)) visit(node, baseDepth, "");
  }
  return { lines, refs, truncated, nextRef };
}
