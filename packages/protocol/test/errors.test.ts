import { describe, expect, it } from "vitest";
import { BrowserUseError, ERROR_CODES, errorPayloadSchema } from "../src/errors";

describe("ERROR_CODES", () => {
  it("lists the stable codes from the spec", () => {
    expect(ERROR_CODES).toEqual([
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
    ]);
  });
});

describe("BrowserUseError", () => {
  it("carries code, hint and details", () => {
    const error = new BrowserUseError("DIALOG_OPEN", "A dialog is open", {
      hint: "Call browser_handle_dialog",
      details: { type: "beforeunload" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("DIALOG_OPEN");
    expect(error.hint).toBe("Call browser_handle_dialog");
    expect(error.details).toEqual({ type: "beforeunload" });
  });

  it("serialises to a payload that the schema accepts", () => {
    const payload = new BrowserUseError("TIMEOUT", "Timed out").toPayload();
    expect(payload).toEqual({ code: "TIMEOUT", message: "Timed out" });
    expect(errorPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("keeps the cause", () => {
    const cause = new Error("root");
    expect(new BrowserUseError("INTERNAL", "boom", { cause }).cause).toBe(cause);
  });

  it("rejects payloads with unknown codes or empty messages", () => {
    expect(errorPayloadSchema.safeParse({ code: "NOPE", message: "x" }).success).toBe(false);
    expect(errorPayloadSchema.safeParse({ code: "TIMEOUT", message: "" }).success).toBe(false);
  });
});
