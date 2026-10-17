import { describe, expect, it, vi } from "vitest";
import { InMemoryRefStore, watchNavigation } from "../src/refs/ref-store";

describe("InMemoryRefStore", () => {
  it("resolves refs set by a snapshot", () => {
    const store = new InMemoryRefStore();
    store.set(
      1,
      new Map([
        ["e1", 40],
        ["e2", 41],
      ]),
    );
    expect(store.resolve(1, "e2")).toBe(41);
    expect(store.has(1)).toBe(true);
  });

  it("throws STALE_REF with a hint for unknown refs, unknown tabs and invalidated tabs", () => {
    const store = new InMemoryRefStore();
    expect(() => store.resolve(1, "e1")).toThrow(
      expect.objectContaining({
        code: "STALE_REF",
        hint: expect.stringContaining("browser_snapshot") as string,
      }),
    );
    store.set(1, new Map([["e1", 40]]));
    expect(() => store.resolve(1, "e9")).toThrow(expect.objectContaining({ code: "STALE_REF" }));
    store.invalidate(1);
    expect(() => store.resolve(1, "e1")).toThrow(expect.objectContaining({ code: "STALE_REF" }));
  });

  it("a new snapshot replaces the old refs wholesale", () => {
    const store = new InMemoryRefStore();
    store.set(1, new Map([["e1", 40]]));
    store.set(1, new Map([["e1", 99]]));
    expect(store.resolve(1, "e1")).toBe(99);
  });
});

describe("watchNavigation", () => {
  function fakeApi() {
    let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
    let removed: ((tabId: number) => void) | undefined;
    const unsubscribe = vi.fn();
    return {
      api: {
        subscribe: (_tab: number, l: typeof listener) => {
          listener = l;
          return unsubscribe;
        },
        onTabRemoved: (l: typeof removed) => {
          removed = l;
          return vi.fn();
        },
      },
      emit: (method: string, params: Record<string, unknown>) => listener?.(method, params),
      remove: (tabId: number) => removed?.(tabId),
      unsubscribe,
    };
  }

  it("invalidates on main-frame navigation only", () => {
    const store = new InMemoryRefStore();
    store.set(1, new Map([["e1", 1]]));
    const fake = fakeApi();
    watchNavigation(fake.api as never, store, 1);
    fake.emit("Page.frameNavigated", {
      frame: { id: "child", parentId: "main", url: "https://x/" },
    });
    expect(store.has(1)).toBe(true);
    fake.emit("Page.navigatedWithinDocument", { url: "https://x/#a" });
    expect(store.has(1)).toBe(true);
    fake.emit("Page.frameNavigated", { frame: { id: "main", url: "https://x/next" } });
    expect(store.has(1)).toBe(false);
  });

  it("invalidates when the tab is removed and returns an unsubscribe function", () => {
    const store = new InMemoryRefStore();
    store.set(2, new Map([["e1", 1]]));
    const fake = fakeApi();
    const stop = watchNavigation(fake.api as never, store, 2);
    fake.remove(2);
    expect(store.has(2)).toBe(false);
    stop();
    expect(fake.unsubscribe).toHaveBeenCalled();
  });
});
