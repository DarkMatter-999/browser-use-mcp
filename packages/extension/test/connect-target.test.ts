import { describe, expect, it, vi } from "vitest";
import { targetTabIdForConnect } from "../src/tabs/connect-target";

describe("active tab selection for Connect", () => {
  it.each(["chrome://newtab/", "chrome://new-tab-page/", "brave://newtab/"])(
    "uses a fresh about:blank tab for the new-tab page %s",
    async (url) => {
      const createTab = vi.fn(() => Promise.resolve({ id: 88 }));
      await expect(targetTabIdForConnect({ id: 12, windowId: 3, url }, createTab)).resolves.toBe(
        88,
      );
      expect(createTab).toHaveBeenCalledWith({ url: "about:blank", active: true, windowId: 3 });
    },
  );

  it.each(["chrome://settings/", "chrome://extensions/", "https://example.com/", "about:blank"])(
    "keeps non-new-tab page %s as the selected tab",
    async (url) => {
      const createTab = vi.fn(() => Promise.resolve({ id: 88 }));
      await expect(targetTabIdForConnect({ id: 12, url }, createTab)).resolves.toBe(12);
      expect(createTab).not.toHaveBeenCalled();
    },
  );
});
