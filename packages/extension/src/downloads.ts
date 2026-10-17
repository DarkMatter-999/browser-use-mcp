import "./zod-jitless";
import { PROTOCOL_VERSION, type WireMessage } from "@browser-use/protocol";

export interface DownloadItemLike {
  id: number;
  filename: string;
  url: string;
  state: string;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
}

export interface DownloadsApi {
  onCreated: { addListener(listener: (item: DownloadItemLike) => void): void };
  onChanged: { addListener(listener: (delta: { id: number }) => void): void };
  search(query: { id: number }): Promise<DownloadItemLike[]>;
}

const STATES = new Set(["in_progress", "complete", "interrupted"]);

function toMessage(item: DownloadItemLike): WireMessage | undefined {
  if (!STATES.has(item.state)) return undefined;
  return {
    type: "download",
    version: PROTOCOL_VERSION,
    downloadId: item.id,
    filename: item.filename,
    url: item.url,
    state: item.state as "in_progress" | "complete" | "interrupted",
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    ...(item.error === undefined ? {} : { error: item.error }),
  };
}

export function trackDownloads(api: DownloadsApi, send: (message: WireMessage) => void): void {
  const forward = (item: DownloadItemLike | undefined) => {
    const message = item ? toMessage(item) : undefined;
    if (!message) return;
    try {
      send(message);
    } catch {
      /* bridge unavailable: the daemon will not see this transition */
    }
  };
  api.onCreated.addListener((item) => {
    forward(item);
  });
  api.onChanged.addListener((delta) => {
    void api.search({ id: delta.id }).then(([item]) => {
      forward(item);
    });
  });
}
