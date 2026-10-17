import { describe, expect, it, vi } from "vitest";
import type { ValidationContext } from "../src/cdp/allowlist";
import { DebuggerAdapter, type DebuggerApi } from "../src/cdp/debugger-adapter";

type Detach = (source: { tabId?: number }) => void;

function makeAdapter(
  onExternalDetach?: (tabId: number) => void,
  contextFor?: (tabId: number) => Promise<ValidationContext>,
) {
  let listener: Detach | undefined;
  const api = {
    attach: vi.fn<DebuggerApi["attach"]>(() => Promise.resolve()),
    sendCommand: vi.fn<DebuggerApi["sendCommand"]>(() => Promise.resolve({})),
    detach: vi.fn<DebuggerApi["detach"]>(() => Promise.resolve()),
    getTargets: vi.fn<DebuggerApi["getTargets"]>(() => Promise.resolve([])),
    onDetach: {
      addListener: vi.fn((fn: Detach) => {
        listener = fn;
      }),
      removeListener: vi.fn(),
    },
  };
  const adapter = new DebuggerAdapter(api, onExternalDetach, contextFor);
  const fireDetach = (source: { tabId?: number }): void => listener?.(source);
  return { adapter, api, fireDetach };
}

describe("DebuggerAdapter", () => {
  it("re-adopts only still-attached tabs after a restart without attaching again", async () => {
    const { adapter, api } = makeAdapter();
    api.getTargets.mockResolvedValueOnce([
      { tabId: 4, attached: true },
      { tabId: 5, attached: false },
      { tabId: 6, attached: true },
      { attached: true },
    ]);
    // Tab 6 is attached by someone else (DevTools): this extension's session cannot use it.
    api.sendCommand.mockImplementation((target) =>
      target.tabId === 6
        ? Promise.reject(new Error("Debugger is not attached"))
        : Promise.resolve({}),
    );
    expect(await adapter.reattach([4, 5, 6, 7])).toEqual([4]);
    expect(api.attach).not.toHaveBeenCalled();
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 4 }, "Runtime.enable", {});
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 4 }, "Page.enable", {});
    expect(adapter.attachedTabs()).toEqual([4]);
    // A second connect of an adopted tab must not call chrome.debugger.attach again.
    await adapter.attach(4);
    expect(api.attach).not.toHaveBeenCalled();
  });

  it("validates URL-scoped methods against the tab's context and never calls Chrome on failure", async () => {
    const contextFor = vi.fn(() =>
      Promise.resolve({ tabUrl: "https://shop.example.com/cart", fileAccess: false }),
    );
    const { adapter, api } = makeAdapter(undefined, contextFor);
    await adapter.attach(30);
    api.sendCommand.mockClear();
    await expect(
      adapter.sendCommand(30, "Page.navigate", { url: "javascript:alert(1)" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      adapter.sendCommand(30, "Network.getCookies", { urls: ["https://bank.test/"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(api.sendCommand).not.toHaveBeenCalled();
    await adapter.sendCommand(30, "Network.getCookies", { urls: ["https://shop.example.com/"] });
    expect(contextFor).toHaveBeenCalledWith(30);
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    contextFor.mockClear();
    await adapter.sendCommand(30, "Runtime.evaluate", { expression: "1" });
    expect(contextFor).not.toHaveBeenCalled();
  });

  it("refuses URL-scoped methods when no context resolver is configured", async () => {
    const { adapter } = makeAdapter();
    await adapter.attach(31);
    await expect(
      adapter.sendCommand(31, "Page.navigate", { url: "https://example.com/" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("attaches, enables Runtime and Page, and forwards allowed commands", async () => {
    const { adapter, api } = makeAdapter();
    await adapter.attach(12);
    expect(api.attach).toHaveBeenCalledWith({ tabId: 12 }, "1.3");
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 12 }, "Runtime.enable", {});
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 12 }, "Page.enable", {});
    api.sendCommand.mockClear();
    await adapter.sendCommand(12, "Runtime.evaluate", { expression: "1+1" });
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 12 }, "Runtime.evaluate", {
      expression: "1+1",
    });
  });

  it("cleans up on external detach and makes detach idempotent", async () => {
    const removed = vi.fn();
    const { adapter, api, fireDetach } = makeAdapter(removed);
    await adapter.attach(12);
    fireDetach({ tabId: 12 });
    expect(removed).toHaveBeenCalledWith(12);
    await adapter.detach(12);
    await adapter.detach(12);
    expect(api.detach).toHaveBeenCalledTimes(0);
  });

  it("calls Chrome detach exactly once for an ordinary detach", async () => {
    const { adapter, api } = makeAdapter();
    await adapter.attach(19);
    await adapter.detach(19);
    await adapter.detach(19);
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("detaches Chrome when required domain initialization fails", async () => {
    const { adapter, api } = makeAdapter();
    api.sendCommand.mockRejectedValue(new Error("Runtime initialization failed"));
    await expect(adapter.attach(20)).rejects.toThrow("Runtime initialization failed");
    expect(api.detach).toHaveBeenCalledTimes(1);
    await expect(
      adapter.sendCommand(20, "Runtime.evaluate", { expression: "1" }),
    ).rejects.toMatchObject({ code: "TAB_NOT_CONNECTED" });
  });

  it("constrains Runtime.evaluate to the supported evaluation parameters", async () => {
    const { adapter } = makeAdapter();
    await adapter.attach(21);
    await expect(
      adapter.sendCommand(21, "Runtime.evaluate", { expression: "1", arbitraryFlag: true }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects non-allowlisted methods with UNSUPPORTED_CDP_METHOD without calling Chrome", async () => {
    const { adapter, api } = makeAdapter();
    await adapter.attach(1);
    await expect(adapter.sendCommand(1, "Target.setAutoAttach", {})).rejects.toMatchObject({
      code: "UNSUPPORTED_CDP_METHOD",
    });
    expect(api.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 1 },
      "Target.setAutoAttach",
      expect.anything(),
    );
  });

  it("rejects invalid params with INVALID_ARGUMENT", async () => {
    const { adapter } = makeAdapter();
    await adapter.attach(1);
    await expect(
      adapter.sendCommand(1, "DOM.setFileInputFiles", { files: [], nodeId: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects commands for tabs that are not attached with TAB_NOT_CONNECTED", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.sendCommand(9, "Page.reload", {})).rejects.toMatchObject({
      code: "TAB_NOT_CONNECTED",
    });
  });

  it("maps Chrome refusing attach to INTERNAL with the restricted-page hint", async () => {
    const { adapter, api } = makeAdapter();
    api.attach.mockRejectedValueOnce(new Error("Cannot access a chrome:// URL"));
    await expect(adapter.attach(1)).rejects.toMatchObject({
      code: "INTERNAL",
      hint: "Chrome does not allow debugging this page (restricted or browser-internal pages cannot be connected).",
    });
  });

  it("passes other Chrome errors through as INTERNAL", async () => {
    const { adapter, api } = makeAdapter();
    await adapter.attach(1);
    api.sendCommand.mockRejectedValueOnce(new Error("boom"));
    await expect(adapter.sendCommand(1, "Page.reload", {})).rejects.toMatchObject({
      code: "INTERNAL",
      message: "boom",
    });
  });

  it("reports attached tabs and forgets a tab after an external detach", async () => {
    const detached: number[] = [];
    const { adapter, fireDetach } = makeAdapter((tabId) => detached.push(tabId));
    await adapter.attach(1);
    expect(adapter.attachedTabs()).toEqual([1]);
    fireDetach({ tabId: 1 });
    expect(adapter.isAttached(1)).toBe(false);
    expect(detached).toEqual([1]);
  });
});
