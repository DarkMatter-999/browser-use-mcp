import "./zod-jitless";
import { PROTOCOL_VERSION, type WireMessage } from "@browser-use/protocol";

export interface DownloadItemLike {
  id: number;
  filename: string;
  url: string;
  finalUrl?: string;
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

export interface DownloadTrackerOptions {
  /** How long a CDP `Page.downloadWillBegin` and a `chrome.downloads` item wait for each other. */
  correlationWindowMs?: number;
  now?: () => number;
}

const STATES = new Set(["in_progress", "complete", "interrupted"]);
const DEFAULT_WINDOW_MS = 30_000;
const MAX_PENDING = 100;

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

function matches(item: { url: string; finalUrl?: string }, url: string): boolean {
  return item.url === url || item.finalUrl === url;
}

/**
 * Forwards only downloads started by a connected tab (spec section 6: the agent sees connected
 * tabs only). `chrome.downloads` items carry no tab id, so an item is claimed when its URL matches
 * a CDP `Page.downloadWillBegin` from an attached tab, in either order, within a short window.
 * Every other download in the profile is never sent to the daemon.
 */
export class DownloadTracker {
  readonly #claimed = new Set<number>();
  readonly #expected: { url: string; at: number }[] = [];
  readonly #unclaimed = new Map<number, { url: string; finalUrl?: string; at: number }>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(
    private readonly api: DownloadsApi,
    private readonly send: (message: WireMessage) => void,
    options: DownloadTrackerOptions = {},
  ) {
    this.#windowMs = options.correlationWindowMs ?? DEFAULT_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    api.onCreated.addListener((item) => {
      this.#onCreated(item);
    });
    api.onChanged.addListener((delta) => {
      if (this.#claimed.has(delta.id)) void this.#refresh(delta.id);
    });
  }

  /** Called for `Page.downloadWillBegin` from a connected tab. */
  expect(url: string): void {
    this.#prune();
    for (const [id, item] of this.#unclaimed) {
      if (matches(item, url)) {
        this.#unclaimed.delete(id);
        this.#claimed.add(id);
        void this.#refresh(id);
        return;
      }
    }
    this.#expected.push({ url, at: this.#now() });
    if (this.#expected.length > MAX_PENDING) this.#expected.shift();
  }

  #onCreated(item: DownloadItemLike): void {
    this.#prune();
    const index = this.#expected.findIndex((entry) => matches(item, entry.url));
    if (index >= 0) {
      this.#expected.splice(index, 1);
      this.#claimed.add(item.id);
      this.#forward(item);
      return;
    }
    this.#unclaimed.set(item.id, {
      url: item.url,
      ...(item.finalUrl === undefined ? {} : { finalUrl: item.finalUrl }),
      at: this.#now(),
    });
    if (this.#unclaimed.size > MAX_PENDING) {
      const [oldest] = this.#unclaimed.keys();
      if (oldest !== undefined) this.#unclaimed.delete(oldest);
    }
  }

  async #refresh(id: number): Promise<void> {
    try {
      const [item] = await this.api.search({ id });
      if (item) this.#forward(item);
    } catch {
      /* the item vanished (erased by the user) */
    }
  }

  #forward(item: DownloadItemLike): void {
    if (item.state === "complete" || item.state === "interrupted") this.#claimed.delete(item.id);
    const message = toMessage(item);
    if (!message) return;
    try {
      this.send(message);
    } catch {
      /* bridge unavailable: the daemon will not see this transition */
    }
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs;
    while (this.#expected[0] && this.#expected[0].at < cutoff) this.#expected.shift();
    for (const [id, item] of this.#unclaimed) {
      if (item.at < cutoff) this.#unclaimed.delete(id);
    }
  }
}

export function trackDownloads(
  api: DownloadsApi,
  send: (message: WireMessage) => void,
  options?: DownloadTrackerOptions,
): DownloadTracker {
  return new DownloadTracker(api, send, options);
}
