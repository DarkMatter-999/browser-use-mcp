import { BrowserUseError } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { asObject, requireTab, tabIdField } from "./schema";

const MAX_PDF_BYTES = 1024 * 1024;
const PDF_READ_CHUNK_BYTES = 64 * 1024;

const pdfShape = {
  tabId: tabIdField,
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
};
const pdfInput = z.object({
  tabId: tabIdField,
  landscape: z.boolean().optional().default(false),
  printBackground: z.boolean().optional().default(true),
});

export interface PdfOutcome {
  tabId: number;
  mimeType: "application/pdf";
  data: string;
  sizeBytes: number;
}

export async function browserPdf(
  ctx: ToolContext,
  input: z.input<typeof pdfInput>,
): Promise<PdfOutcome> {
  const { tabId, landscape, printBackground } = pdfInput.parse(input);
  requireTab(ctx, tabId);
  const result = asObject(
    await ctx.sendCommand(
      tabId,
      "Page.printToPDF",
      { landscape, printBackground, transferMode: "ReturnAsStream" },
      30_000,
    ),
  );
  const handle = typeof result.stream === "string" ? result.stream : "";
  if (!handle) {
    throw new BrowserUseError("INTERNAL", "Chrome did not return a PDF stream");
  }
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    let eof = false;
    while (!eof) {
      const size = Math.min(PDF_READ_CHUNK_BYTES, MAX_PDF_BYTES - sizeBytes + 1);
      const chunk = asObject(await ctx.sendCommand(tabId, "IO.read", { handle, size }));
      const encoded = typeof chunk.data === "string" ? chunk.data : "";
      const bytes =
        chunk.base64Encoded === false ? Buffer.from(encoded) : Buffer.from(encoded, "base64");
      if (sizeBytes + bytes.byteLength > MAX_PDF_BYTES) {
        throw new BrowserUseError("LIMIT_EXCEEDED", "PDF exceeds the 1 MiB limit", {
          hint: "Export a smaller page.",
        });
      }
      if (bytes.byteLength) {
        chunks.push(bytes);
        sizeBytes += bytes.byteLength;
      } else if (chunk.eof !== true) {
        throw new BrowserUseError("INTERNAL", "Chrome returned an empty non-final PDF chunk");
      }
      eof = chunk.eof === true;
    }
  } finally {
    await ctx.sendCommand(tabId, "IO.close", { handle }).catch(() => undefined);
  }
  if (!sizeBytes) throw new BrowserUseError("INTERNAL", "Chrome returned an empty PDF");
  const data = Buffer.concat(chunks, sizeBytes);
  return { tabId, mimeType: "application/pdf", data: data.toString("base64"), sizeBytes };
}

export const exportTools = [
  defineTool({
    name: "browser_pdf",
    title: "Export PDF",
    description: "Export a connected tab as a bounded PDF document.",
    inputShape: pdfShape,
    handler: async (ctx, args) => {
      const pdf = await browserPdf(ctx, args);
      return jsonResult({ mimeType: pdf.mimeType, sizeBytes: pdf.sizeBytes, data: pdf.data });
    },
  }),
];
