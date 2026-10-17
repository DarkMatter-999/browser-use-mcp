import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { requireTab, tabIdField } from "./schema";

interface Overrides {
  viewport?: boolean;
  geolocation?: boolean;
  userAgent?: boolean;
  network?: boolean;
}

const emulateShape = {
  tabId: tabIdField,
  viewport: z
    .object({
      width: z.number().int().positive().max(10_000),
      height: z.number().int().positive().max(10_000),
      deviceScaleFactor: z.number().positive().max(10).optional(),
      mobile: z.boolean().optional(),
    })
    .optional(),
  geolocation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().max(100_000).optional(),
    })
    .optional(),
  userAgent: z.string().min(1).max(1024).optional(),
  offline: z.boolean().optional(),
  network: z
    .object({
      latency: z.number().min(0).max(60_000),
      downloadThroughput: z.number().min(-1).max(1_000_000_000),
      uploadThroughput: z.number().min(-1).max(1_000_000_000),
    })
    .optional(),
};
const resetShape = { tabId: tabIdField };
const schema = z.object(emulateShape);

const states = new WeakMap<ToolContext, Map<number, Overrides>>();
const removalSubscriptions = new WeakMap<ToolContext, () => void>();

export async function browserEmulate(
  ctx: ToolContext,
  input: z.input<typeof schema>,
): Promise<{ tabId: number; applied: string[] }> {
  const args = schema.parse(input);
  cleanupDisconnected(ctx);
  requireTab(ctx, args.tabId);
  const state = stateFor(ctx, args.tabId);
  if (args.viewport) {
    await ctx.sendCommand(args.tabId, "Emulation.setDeviceMetricsOverride", {
      width: args.viewport.width,
      height: args.viewport.height,
      deviceScaleFactor: args.viewport.deviceScaleFactor ?? 1,
      mobile: args.viewport.mobile ?? false,
    });
    state.viewport = true;
  }
  if (args.geolocation) {
    await ctx.sendCommand(args.tabId, "Emulation.setGeolocationOverride", {
      latitude: args.geolocation.latitude,
      longitude: args.geolocation.longitude,
      accuracy: args.geolocation.accuracy ?? 1,
    });
    state.geolocation = true;
  }
  if (args.userAgent !== undefined) {
    await ctx.sendCommand(args.tabId, "Emulation.setUserAgentOverride", {
      userAgent: args.userAgent,
    });
    state.userAgent = true;
  }
  if (args.offline !== undefined || args.network) {
    await ctx.sendCommand(args.tabId, "Network.emulateNetworkConditions", {
      offline: args.offline ?? false,
      latency: args.network?.latency ?? 0,
      downloadThroughput: args.network?.downloadThroughput ?? -1,
      uploadThroughput: args.network?.uploadThroughput ?? -1,
      connectionType: "none",
    });
    state.network = true;
  }
  return { tabId: args.tabId, applied: Object.keys(state) };
}

export async function browserResetEmulation(
  ctx: ToolContext,
  input: z.input<z.ZodObject<typeof resetShape>>,
): Promise<{ tabId: number; reset: boolean; cleaned?: boolean }> {
  const { tabId } = z.object(resetShape).parse(input);
  const active = ctx.listTabs().some((tab) => tab.tabId === tabId);
  const state = states.get(ctx)?.get(tabId);
  // Chrome removes per-target emulation overrides when the debugger target detaches.
  if (!active) {
    states.get(ctx)?.delete(tabId);
    return { tabId, reset: false, cleaned: state !== undefined };
  }
  if (state) {
    if (state.viewport) await ctx.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride", {});
    if (state.geolocation) await ctx.sendCommand(tabId, "Emulation.clearGeolocationOverride", {});
    if (state.userAgent) {
      await ctx.sendCommand(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
    }
    // Network is shared with diagnostics. Restore neutral conditions; never disable the domain.
    if (state.network) {
      await ctx.sendCommand(tabId, "Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      });
    }
    states.get(ctx)?.delete(tabId);
  }
  return { tabId, reset: true };
}

function cleanupDisconnected(ctx: ToolContext): void {
  const active = new Set(ctx.listTabs().map((tab) => tab.tabId));
  for (const tabId of states.get(ctx)?.keys() ?? []) {
    if (!active.has(tabId)) states.get(ctx)?.delete(tabId);
  }
}

function stateFor(ctx: ToolContext, tabId: number): Overrides {
  subscribeToRemovals(ctx);
  let byTab = states.get(ctx);
  if (!byTab) {
    byTab = new Map();
    states.set(ctx, byTab);
  }
  let state = byTab.get(tabId);
  if (!state) {
    state = {};
    byTab.set(tabId, state);
  }
  return state;
}

function subscribeToRemovals(ctx: ToolContext): void {
  if (removalSubscriptions.has(ctx)) return;
  const unsubscribe = ctx.onTabRemoved((tabId) => {
    const byTab = states.get(ctx);
    byTab?.delete(tabId);
    if (byTab?.size === 0) {
      const removeListener = removalSubscriptions.get(ctx);
      removalSubscriptions.delete(ctx);
      removeListener?.();
    }
  });
  removalSubscriptions.set(ctx, unsubscribe);
}

export const emulationTools = [
  defineTool({
    name: "browser_emulate",
    title: "Emulate device",
    description:
      "Apply viewport, geolocation, user-agent, offline, or network throttling overrides to a connected tab.",
    inputShape: emulateShape,
    handler: async (ctx, args) => jsonResult(await browserEmulate(ctx, args)),
  }),
  defineTool({
    name: "browser_reset_emulation",
    title: "Reset emulation",
    description:
      "Restore tracked emulation overrides for a connected or recently disconnected tab.",
    inputShape: resetShape,
    handler: async (ctx, args) => jsonResult(await browserResetEmulation(ctx, args)),
  }),
];
