import { z } from "zod";
import { errorPayloadSchema } from "./errors";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import { parseMessage } from "./parse";
import { PROTOCOL_VERSION } from "./version";

export const MAX_WIRE_MESSAGE_BYTES = 2 * 1024 * 1024;

const version = z.literal(PROTOCOL_VERSION);
const requestId = z.uuid();
const tabId = z.number().int().positive();
const cdpMethod = z.string().min(1).max(128);

export const pendingDialogSchema = z.object({
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string(),
  url: z.string(),
  defaultPrompt: z.string().optional(),
});
export type PendingDialog = z.infer<typeof pendingDialogSchema>;

export const navigableUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:" || value === "about:blank";
}, "Only http, https and about:blank URLs can be opened");

export const connectedTabSchema = z.object({
  tabId,
  url: z.string().min(1),
  title: z.string(),
  active: z.boolean().optional(),
  autoConnected: z.boolean().optional(),
  pendingDialog: pendingDialogSchema.optional(),
});
export type ConnectedTab = z.infer<typeof connectedTabSchema>;

export const helloSchema = z.object({
  type: z.literal("hello"),
  version,
  peerId: z.uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  extensionVersion: z.string().min(1),
});

export const helloAckSchema = z.object({
  type: z.literal("helloAck"),
  version,
  daemonVersion: z.string().min(1),
});

export const registerTabSchema = connectedTabSchema.extend({
  type: z.literal("registerTab"),
  version,
});

export const unregisterTabSchema = z.object({
  type: z.literal("unregisterTab"),
  version,
  tabId,
  reason: z.string().optional(),
});

export const commandSchema = z.object({
  type: z.literal("command"),
  version,
  requestId,
  tabId,
  method: cdpMethod,
  params: jsonObjectSchema,
});

export const openTabSchema = z.object({
  type: z.literal("openTab"),
  version,
  requestId,
  url: navigableUrl,
});

export const closeTabSchema = z.object({
  type: z.literal("closeTab"),
  version,
  requestId,
  tabId,
});

export const fileAccessSchema = z.object({
  type: z.literal("fileAccess"),
  version,
  requestId,
});

export const responseSchema = z.object({
  type: z.literal("response"),
  version,
  requestId,
  result: jsonValueSchema,
});

export const eventSchema = z.object({
  type: z.literal("event"),
  version,
  tabId,
  method: cdpMethod,
  params: jsonObjectSchema,
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  version,
  requestId: requestId.optional(),
  error: errorPayloadSchema,
});

export const pairSchema = z.object({
  type: z.literal("pair"),
  version,
  code: z.string().regex(/^[A-Z2-9]{8}$/),
});
export const pairedSchema = z.object({
  type: z.literal("paired"),
  version,
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export const downloadStateSchema = z.enum(["in_progress", "complete", "interrupted"]);
export const downloadSchema = z.object({
  type: z.literal("download"),
  version,
  downloadId: z.number().int().nonnegative(),
  filename: z.string(),
  url: z.string(),
  state: downloadStateSchema,
  bytesReceived: z.number().nonnegative(),
  totalBytes: z.number(),
  error: z.string().optional(),
});

export const pingSchema = z.object({ type: z.literal("ping"), version });
export const pongSchema = z.object({ type: z.literal("pong"), version });

export const wireMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  helloAckSchema,
  registerTabSchema,
  unregisterTabSchema,
  commandSchema,
  openTabSchema,
  closeTabSchema,
  fileAccessSchema,
  responseSchema,
  eventSchema,
  errorMessageSchema,
  pingSchema,
  pongSchema,
  pairSchema,
  pairedSchema,
  downloadSchema,
]);

export type WireMessage = z.infer<typeof wireMessageSchema>;

export function parseWireMessage(text: string): WireMessage {
  return parseMessage(wireMessageSchema, text, {
    label: "Bridge",
    maxBytes: MAX_WIRE_MESSAGE_BYTES,
    versionKey: "version",
  });
}

export function serializeWireMessage(message: WireMessage): string {
  return JSON.stringify(wireMessageSchema.parse(message));
}
