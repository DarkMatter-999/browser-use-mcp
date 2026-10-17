import type { WireMessage } from "@browser-use/protocol";
import { describe, expect, it, vi } from "vitest";
import { type DownloadItemLike, type DownloadsApi, trackDownloads } from "../src/downloads";

function fakeApi(items: Record<number, DownloadItemLike>) {
  let created: ((item: DownloadItemLike) => void) | undefined;
  let changed: ((delta: { id: number }) => void) | undefined;
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
    search: vi.fn(({ id }: { id: number }) => {
      const found = items[id];
      return Promise.resolve(found ? [found] : []);
    }),
  };
  return {
    api,
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
    trackDownloads(fake.api, (m) => sent.push(m));
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
    trackDownloads(fake.api, (m) => sent.push(m));
    fake.changed(2);
    fake.changed(3);
    fake.changed(99);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ state: "interrupted", error: "NETWORK_FAILED" });
  });

  it("swallows send failures", async () => {
    const fake = fakeApi({ 1: item() });
    trackDownloads(fake.api, () => {
      throw new Error("bridge down");
    });
    fake.changed(1);
    await tick();
  });
});
