import type { DownloadInfo, JsonValue } from "@browser-use/protocol";
import type { ToolContext } from "../mcp/context";

export interface ActionMarker {
  downloadSequence: number;
}

const SETTLE_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for per-tab markers
export async function beginAction(ctx: ToolContext, _tabId: number): Promise<ActionMarker> {
  const downloads = await ctx.listDownloads().catch((): DownloadInfo[] => []);
  return { downloadSequence: Math.max(0, ...downloads.map((download) => download.sequence)) };
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
  return {
    ...base,
    ...(tab ? { page: { url: tab.url, title: tab.title } } : {}),
    ...(tab?.pendingDialog ? { dialog: tab.pendingDialog as unknown as JsonValue } : {}),
    ...(downloads.length ? { downloads: downloads as unknown as JsonValue } : {}),
  };
}
