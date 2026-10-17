import { describe, expect, it } from "vitest";
import { browserDownloads } from "../src/tools/downloads";
import { makeContext } from "./helpers/context";

const dl = (sequence: number, state: "in_progress" | "complete" | "interrupted") => ({
  downloadId: sequence,
  filename: `/tmp/${sequence}`,
  url: "http://x/",
  state,
  bytesReceived: 1,
  totalBytes: 1,
  sequence,
});

describe("browser_downloads", () => {
  const ctx = makeContext({
    listDownloads: () =>
      Promise.resolve([dl(3, "complete"), dl(1, "in_progress"), dl(2, "interrupted")]),
  });
  it("lists downloads in sequence order", async () => {
    expect((await browserDownloads(ctx, {})).downloads.map((d) => d.sequence)).toEqual([1, 2, 3]);
  });
  it("filters by sinceSequence and state", async () => {
    expect(
      (await browserDownloads(ctx, { sinceSequence: 1 })).downloads.map((d) => d.sequence),
    ).toEqual([2, 3]);
    expect(
      (await browserDownloads(ctx, { state: "complete" })).downloads.map((d) => d.sequence),
    ).toEqual([3]);
  });
});
