import type { z } from "zod";
import { BrowserUseError } from "./errors";
import { PROTOCOL_VERSION } from "./version";

export interface ParseOptions {
  label: string;
  maxBytes: number;
  versionKey: "version" | "protocolVersion";
}

export function parseMessage<T>(schema: z.ZodType<T>, text: string, options: ParseOptions): T {
  const { label, maxBytes, versionKey } = options;

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new BrowserUseError("INVALID_ARGUMENT", `${label} message exceeds the size limit`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new BrowserUseError("INVALID_ARGUMENT", `${label} message is not valid JSON`, { cause });
  }

  if (typeof raw === "object" && raw !== null && versionKey in raw) {
    const received = (raw as Record<string, unknown>)[versionKey];
    if (received !== PROTOCOL_VERSION) {
      throw new BrowserUseError(
        "VERSION_MISMATCH",
        `${label} protocol version ${String(received)} is not supported (expected ${PROTOCOL_VERSION})`,
        { hint: "Update the Browser Use extension and server to the same release." },
      );
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new BrowserUseError("INVALID_ARGUMENT", `Invalid ${label} message: ${issues}`);
  }
  return parsed.data;
}
