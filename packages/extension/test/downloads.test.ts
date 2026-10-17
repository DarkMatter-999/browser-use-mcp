import type { WireMessage } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import { type DownloadItemLike, type DownloadsApi, trackDownloads } from "../src/downloads";

function fakeApi(items: Record<number, DownloadItemLike>) {
  let created: ((item: DownloadItemLike) => void) | undefined;
  let changed: ((delta: { id: number }) => void) | undefined;
  const search = vi.fn(({ id }: { id: number }) => {
    const found = items[id];
    return Promise.resolve(found ? [found] : []);
  });
  const api: DownloadsApi = {
    onCreated: {
      addListener: (l) => {
        created = l;
      },
    },
    onChanged: {
      addListener: (l) => {
        changed = l;
      },
    },
    search,
  };
  return {
    api,
    search,
    created: (item: DownloadItemLike) => created?.(item),
    changed: (id: number) => changed?.({ id }),
  };
}

const item = (over: Partial<DownloadItemLike> = {}): DownloadItemLike => ({
  id: 1,
  filename: "",
  url: "http://127.0.0.1/a.txt",
  state: "in_progress",
  bytesReceived: 0,
  totalBytes: 10,
  ...over,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("trackDownloads", () => {
  it("sends in_progress on creation and complete on change", async () => {
    const items: Record<number, DownloadItemLike> = { 1: item() };
    const sent: WireMessage[] = [];
    const fake = fakeApi(items);
    const tracker = trackDownloads(fake.api, (m) => sent.push(m));
    tracker.expect("http://127.0.0.1/a.txt");
    fake.created(item());
    items[1] = item({ state: "complete", filename: "/home/u/Downloads/a.txt", bytesReceived: 10 });
    fake.changed(1);
    await tick();
    expect(sent.map((m) => (m.type === "download" ? m.state : m.type))).toEqual([
      "in_progress",
      "complete",
    ]);
    expect(sent[1]).toMatchObject({
      type: "download",
      downloadId: 1,
      filename: "/home/u/Downloads/a.txt",
      bytesReceived: 10,
      totalBytes: 10,
    });
  });

  it("carries interruption errors and ignores unknown states and missing items", async () => {
    const items: Record<number, DownloadItemLike> = {
      2: item({ id: 2, state: "interrupted", error: "NETWORK_FAILED" }),
      3: item({ id: 3, state: "paused" }),
    };
    const sent: WireMessage[] = [];
    const fake = fakeApi(items);
    const tracker = trackDownloads(fake.api, (m) => sent.push(m));
    for (const id of [2, 3, 99]) {
      tracker.expect(`http://127.0.0.1/${id}`);
      fake.created(item({ id, url: `http://127.0.0.1/${id}` }));
    }
    sent.length = 0;
    fake.changed(2);
    fake.changed(3);
    fake.changed(99);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ state: "interrupted", error: "NETWORK_FAILED" });
  });

  it("swallows send failures", async () => {
    const fake = fakeApi({ 1: item() });
    const tracker = trackDownloads(fake.api, () => {
      throw new Error("bridge down");
    });
    tracker.expect(item().url);
    fake.created(item());
    fake.changed(1);
    await tick();
  });

  it("never forwards downloads that no connected tab started", async () => {
    const items: Record<number, DownloadItemLike> = {
      5: item({ id: 5, url: "https://bank.test/statement.pdf?sig=secret", state: "complete" }),
    };
    const sent: WireMessage[] = [];
    const fake = fakeApi(items);
    const tracker = trackDownloads(fake.api, (m) => sent.push(m));
    tracker.expect("http://127.0.0.1/other.txt");
    fake.created(item({ id: 5, url: "https://bank.test/statement.pdf?sig=secret" }));
    fake.changed(5);
    await tick();
    expect(sent).toEqual([]);
    expect(fake.search).not.toHaveBeenCalled();
  });

  it("claims an item created before the tab's downloadWillBegin and sends its latest state", async () => {
    const items: Record<number, DownloadItemLike> = {
      6: item({
        id: 6,
        url: "http://a.test/r",
        finalUrl: "http://a.test/f.zip",
        state: "complete",
      }),
    };
    const sent: WireMessage[] = [];
    const fake = fakeApi(items);
    const tracker = trackDownloads(fake.api, (m) => sent.push(m));
    fake.created(item({ id: 6, url: "http://a.test/r", finalUrl: "http://a.test/f.zip" }));
    expect(sent).toEqual([]);
    tracker.expect("http://a.test/f.zip");
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ downloadId: 6, state: "complete" });
  });

  it("expires unmatched expectations and items after the correlation window", async () => {
    let now = 1_000;
    const sent: WireMessage[] = [];
    const fake = fakeApi({ 7: item({ id: 7 }) });
    const tracker = trackDownloads(fake.api, (m) => sent.push(m), {
      correlationWindowMs: 100,
      now: () => now,
    });
    tracker.expect(item().url);
    now += 500;
    fake.created(item({ id: 7 }));
    now += 500;
    tracker.expect(item().url);
    await tick();
    expect(sent).toEqual([]);
  });
});
