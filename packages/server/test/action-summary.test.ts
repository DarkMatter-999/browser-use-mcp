import { describe, expect, it } from "vitest";
import { beginAction, finishAction } from "../src/tools/action-summary";
import { makeContext } from "./helpers/context";

const download = (sequence: number) => ({
  downloadId: sequence,
  filename: `/tmp/f${sequence}`,
  url: "http://x/",
  state: "complete" as const,
  bytesReceived: 1,
  totalBytes: 1,
  sequence,
});

describe("action summary", () => {
  it("adds the current page url and title", async () => {
    const ctx = makeContext({
      listTabs: () => [{ tabId: 1, url: "https://a/next", title: "Next" }],
      listDownloads: () => Promise.resolve([]),
    });
    const marker = await beginAction(ctx, 1);
    expect(
      await finishAction(ctx, 1, { tabId: 1, performed: true, action: "click" }, marker),
    ).toEqual({
      tabId: 1,
      performed: true,
      action: "click",
      page: { url: "https://a/next", title: "Next" },
    });
  });

  it("includes a dialog that the action opened", async () => {
    const dialog = { type: "confirm" as const, message: "Sure?", url: "https://a/" };
    const ctx = makeContext({
      listTabs: () => [{ tabId: 1, url: "https://a/", title: "A", pendingDialog: dialog }],
      listDownloads: () => Promise.resolve([]),
    });
    const result = await finishAction(ctx, 1, { action: "click" }, await beginAction(ctx, 1));
    expect(result.dialog).toEqual(dialog);
  });

  it("includes only downloads that started after beginAction", async () => {
    let list = [download(1)];
    const ctx = makeContext({
      listTabs: () => [{ tabId: 1, url: "https://a/", title: "A" }],
      listDownloads: () => Promise.resolve(list),
    });
    const marker = await beginAction(ctx, 1);
    list = [download(1), download(2)];
    const result = await finishAction(ctx, 1, { action: "click" }, marker);
    expect(result.downloads).toEqual([download(2)]);
  });

  it("copes with the tab disappearing", async () => {
    const ctx = makeContext({ listTabs: () => [], listDownloads: () => Promise.resolve([]) });
    const result = await finishAction(ctx, 1, { action: "click" }, await beginAction(ctx, 1));
    expect(result.page).toBeUndefined();
  });
});
