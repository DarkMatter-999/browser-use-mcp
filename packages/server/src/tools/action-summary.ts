import type { DownloadInfo, JsonValue } from "@browser-use/protocol";
import { chooserWatch } from "../files/chooser-watch";
import type { ToolContext } from "../mcp/context";

export interface ActionMarker {
  downloadSequence: number;
}

const SETTLE_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lastActionMarkers = new WeakMap<ToolContext, Map<number, number>>();

function markersFor(ctx: ToolContext): Map<number, number> {
  let markers = lastActionMarkers.get(ctx);
  if (!markers) {
    markers = new Map();
    lastActionMarkers.set(ctx, markers);
  }
  return markers;
}

/**
 * The download sequence at the start of the latest action on this tab, so a later
 * browser_wait for a download also sees one that finished while the action was settling.
 */
export function downloadBaseline(ctx: ToolContext, tabId: number): number | undefined {
  return lastActionMarkers.get(ctx)?.get(tabId);
}

/** Moves the baseline past a download that a wait has already reported. */
export function advanceDownloadBaseline(ctx: ToolContext, tabId: number, sequence: number): void {
  const markers = markersFor(ctx);
  markers.set(tabId, Math.max(sequence, markers.get(tabId) ?? 0));
}

export async function beginAction(ctx: ToolContext, tabId: number): Promise<ActionMarker> {
  const downloads = await ctx.listDownloads().catch((): DownloadInfo[] => []);
  const downloadSequence = Math.max(0, ...downloads.map((download) => download.sequence));
  markersFor(ctx).set(tabId, downloadSequence);
  return { downloadSequence };
}

export async function finishAction(
  ctx: ToolContext,
  tabId: number,
  base: Record<string, JsonValue>,
  marker: ActionMarker,
): Promise<Record<string, JsonValue>> {
  await sleep(SETTLE_MS);
  const tab = ctx.listTabs().find((entry) => entry.tabId === tabId);
  const downloads = (await ctx.listDownloads().catch((): DownloadInfo[] => [])).filter(
    (download) => download.sequence > marker.downloadSequence,
  );
  const chooser = chooserWatch.peek(ctx, tabId);
  return {
    ...base,
    ...(tab ? { page: { url: tab.url, title: tab.title } } : {}),
    ...(tab?.pendingDialog ? { dialog: tab.pendingDialog as unknown as JsonValue } : {}),
    ...(chooser ? { fileChooser: { open: true, multiple: chooser.multiple } } : {}),
    ...(downloads.length ? { downloads: downloads as unknown as JsonValue } : {}),
  };
}
