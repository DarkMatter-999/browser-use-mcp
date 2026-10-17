import { z } from "zod";
import { type JsonObject, jsonObjectSchema } from "./json";

export const ERROR_CODES = [
  "NOT_PAIRED",
  "BRIDGE_DISCONNECTED",
  "TAB_NOT_CONNECTED",
  "STALE_REF",
  "DIALOG_OPEN",
  "UNSUPPORTED_CDP_METHOD",
  "TIMEOUT",
  "PAGE_EXCEPTION",
  "INVALID_ARGUMENT",
  "VERSION_MISMATCH",
  "INTERNAL",
  "ELEMENT_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "ELEMENT_NOT_INTERACTABLE",
  "NAVIGATION_FAILED",
  "LIMIT_EXCEEDED",
  "BRIDGE_IN_USE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  hint: z.string().optional(),
  details: jsonObjectSchema.optional(),
});

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

export interface BrowserUseErrorOptions {
  hint?: string;
  details?: JsonObject;
  cause?: unknown;
}

export class BrowserUseError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: JsonObject | undefined;

  constructor(code: ErrorCode, message: string, options: BrowserUseErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserUseError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
