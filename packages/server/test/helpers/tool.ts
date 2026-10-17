import type { AnyTool } from "../../src/mcp/define-tool";

export function findTool(tools: readonly AnyTool[], name: string): AnyTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

export const parseText = (output: { content: { type: string; text?: string }[] }): unknown =>
  JSON.parse(output.content[0]?.text ?? "");
