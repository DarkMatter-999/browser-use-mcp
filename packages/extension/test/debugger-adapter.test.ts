import { describe, expect, it, vi } from "vitest";
import { DebuggerAdapter, type DebuggerApi } from "../src/cdp/debugger-adapter";

type Detach = (source: { tabId?: number }) => void;

function makeAdapter(onExternalDetach?: (tabId: number) => void) {
  let listener: Detach | undefined;
  const api = {
    attach: vi.fn<DebuggerApi["attach"]>(() => Promise.resolve()),
    sendCommand: vi.fn<DebuggerApi["sendCommand"]>(() => Promise.resolve({})),
    detach: vi.fn<DebuggerApi["detach"]>(() => Promise.resolve()),
    onDetach: {
      addListener: vi.fn((fn: Detach) => {
        listener = fn;
      }),
      removeListener: vi.fn(),
    },
  };
  const adapter = new DebuggerAdapter(api, onExternalDetach);
  const fireDetach = (source: { tabId?: number }): void => listener?.(source);
  return { adapter, api, fireDetach };
}

describe("DebuggerAdapter", () => {
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
