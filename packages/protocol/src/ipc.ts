import { z } from "zod";
import { errorPayloadSchema } from "./errors";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import { parseMessage } from "./parse";
import { PROTOCOL_VERSION } from "./version";
import { connectedTabSchema, downloadStateSchema, navigableUrl } from "./wire";

export const MAX_IPC_MESSAGE_BYTES = 8 * 1024 * 1024;

const protocolVersion = z.literal(PROTOCOL_VERSION);
const id = z.number().int().nonnegative();
const tabId = z.number().int().positive();
const subscriptionId = z.uuid();

export const downloadInfoSchema = z.object({
  downloadId: z.number().int().nonnegative(),
  filename: z.string(),
  url: z.string(),
  state: downloadStateSchema,
  bytesReceived: z.number().nonnegative(),
  totalBytes: z.number(),
  error: z.string().optional(),
  sequence: z.number().int().positive(),
});
export type DownloadInfo = z.infer<typeof downloadInfoSchema>;

export const daemonStatusSchema = z.object({
  daemonVersion: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  paired: z.boolean(),
  extensionConnected: z.boolean(),
  tabs: z.array(connectedTabSchema),
  mode: z.literal("extension"),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

const ipcHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion,
  clientVersion: z.string().min(1),
});

export const ipcClientMessageSchema = z.discriminatedUnion("type", [
  ipcHelloSchema,
  z.object({ type: z.literal("status"), id }),
  z.object({ type: z.literal("listTabs"), id }),
  z.object({ type: z.literal("openTab"), id, url: navigableUrl }),
  z.object({ type: z.literal("closeTab"), id, tabId }),
  z.object({
    type: z.literal("sendCommand"),
    id,
    tabId,
    method: z.string().min(1).max(128),
    params: jsonObjectSchema,
    timeoutMs: z.number().int().min(1).max(300_000),
  }),
  z.object({ type: z.literal("createPairingCode"), id }),
  z.object({ type: z.literal("resetToken"), id }),
  z.object({ type: z.literal("shutdown"), id }),
  z.object({ type: z.literal("listDownloads"), id }),
  z.object({ type: z.literal("fileAccess"), id }),
  z.object({ type: z.literal("subscribe"), subscriptionId, tabId }),
  z.object({ type: z.literal("subscribeRemoval"), subscriptionId }),
  z.object({ type: z.literal("unsubscribe"), subscriptionId }),
]);

export type IpcClientMessage = z.infer<typeof ipcClientMessageSchema>;

export const ipcServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("helloAck"),
    protocolVersion,
    daemonVersion: z.string().min(1),
  }),
  z.object({ type: z.literal("result"), id, value: jsonValueSchema }),
  z.object({ type: z.literal("failure"), id, error: errorPayloadSchema }),
  z.object({
    type: z.literal("event"),
    subscriptionId,
    method: z.string().min(1).max(128),
    params: jsonObjectSchema,
  }),
  z.object({ type: z.literal("tabsChanged"), tabs: z.array(connectedTabSchema) }),
  z.object({ type: z.literal("downloadsChanged"), downloads: z.array(downloadInfoSchema) }),
  z.object({ type: z.literal("tabRemoved"), subscriptionId, tabId }),
]);

export type IpcServerMessage = z.infer<typeof ipcServerMessageSchema>;

export function parseIpcClientMessage(line: string): IpcClientMessage {
  return parseMessage(ipcClientMessageSchema, line, {
    label: "IPC client",
    maxBytes: MAX_IPC_MESSAGE_BYTES,
    versionKey: "protocolVersion",
  });
}

export function parseIpcServerMessage(line: string): IpcServerMessage {
  return parseMessage(ipcServerMessageSchema, line, {
    label: "IPC daemon",
    maxBytes: MAX_IPC_MESSAGE_BYTES,
    versionKey: "protocolVersion",
  });
}

export function serializeIpcMessage(message: IpcClientMessage | IpcServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
