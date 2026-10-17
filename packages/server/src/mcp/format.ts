import { BrowserUseError } from "@browser-use/protocol";

export type ToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolOutput {
  content: ToolContent[];
  isError?: boolean;
}

export const jsonResult = (value: unknown): ToolOutput => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
export const textResult = (text: string): ToolOutput => ({ content: [{ type: "text", text }] });
export const imageResult = (data: string, mimeType: string): ToolOutput => ({
  content: [{ type: "image", data, mimeType }],
});

export function errorOutput(error: unknown): ToolOutput {
  const payload =
    error instanceof BrowserUseError
      ? error.toPayload()
      : new BrowserUseError(
          "INTERNAL",
          error instanceof Error ? error.message : String(error),
        ).toPayload();
  return { content: [{ type: "text", text: JSON.stringify({ error: payload }) }], isError: true };
}
