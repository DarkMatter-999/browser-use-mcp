import { describe, expect, it, vi } from "vitest";
import { addToBrowserUseGroup, GROUP_TITLE, type GroupApi } from "../src/tabs/groups";

function fakeApi(existing: { id: number }[] = []) {
  const api = {
    tabs: {
      get: vi.fn(() => Promise.resolve({ windowId: 7 })),
      group: vi.fn(() => Promise.resolve(42)),
    },
    tabGroups: {
      query: vi.fn(() => Promise.resolve(existing)),
      update: vi.fn(() => Promise.resolve({})),
    },
  } satisfies GroupApi;
  return api;
}

describe("addToBrowserUseGroup", () => {
  it("creates and titles a group when none exists in the window", async () => {
    const api = fakeApi();
    await addToBrowserUseGroup(api, 5);
    expect(api.tabGroups.query).toHaveBeenCalledWith({ title: GROUP_TITLE, windowId: 7 });
    expect(api.tabs.group).toHaveBeenCalledWith({ tabIds: [5] });
    expect(api.tabGroups.update).toHaveBeenCalledWith(42, { title: GROUP_TITLE, color: "blue" });
  });

  it("reuses an existing group in the same window", async () => {
    const api = fakeApi([{ id: 11 }]);
    await addToBrowserUseGroup(api, 5);
    expect(api.tabs.group).toHaveBeenCalledWith({ tabIds: [5], groupId: 11 });
    expect(api.tabGroups.update).not.toHaveBeenCalled();
  });
});
