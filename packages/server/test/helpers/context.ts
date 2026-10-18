import type { ConnectedTab, JsonObject, JsonValue } from "@browser-use/protocol";
import { BrowserUseError } from "@browser-use/protocol";
import type { CdpListener, ToolContext } from "../../src/mcp/context";
import { NullPointer } from "../../src/pointer/null-pointer";
import type { RefStore } from "../../src/refs/types";

const noop = (): void => undefined;

export function memoryRefs(): RefStore {
  const store = new Map<number, ReadonlyMap<string, number>>();
  return {
    set: (tabId, refs) => {
      store.set(tabId, refs);
    },
    resolve: (tabId, ref) => {
      const id = store.get(tabId)?.get(ref);
      if (id === undefined) {
        throw new BrowserUseError("STALE_REF", `Ref ${ref} is not valid`, {
          hint: "Take a new browser_snapshot.",
        });
      }
      return id;
    },
    invalidate: (tabId) => {
      store.delete(tabId);
    },
    has: (tabId) => store.has(tabId),
  };
}

export function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    listTabs: () => [],
    status: () =>
      Promise.resolve({
        daemonVersion: "0.0.0",
        pid: 1,
        port: 0,
        paired: false,
        extensionConnected: false,
        tabs: [],
        mode: "extension",
        requestedMode: "extension",
        profile: "default",
        capabilities: {
          cdp: true,
          downloads: true,
          dialogs: true,
          fileAccess: true,
          pointer: true,
        },
      }),
    openTab: () => Promise.resolve(1),
    closeTab: () => Promise.resolve(),
    isFileAccessAllowed: () => Promise.resolve(false),
    sendCommand: () => Promise.reject(new Error("unexpected sendCommand")),
    listDownloads: () => Promise.resolve([]),
    subscribe: () => noop,
    onTabRemoved: () => noop,
    refs: memoryRefs(),
    pointer: new NullPointer(),
    ...overrides,
  };
}

export interface RecordedCall {
  tabId: number;
  method: string;
  params: JsonObject;
}

export interface ScriptedContext extends ToolContext {
  calls: RecordedCall[];
  emit(tabId: number, method: string, params: JsonObject): void;
  removeTab(tabId: number): void;
}

export function scriptedContext(
  handlers: Record<string, (params: JsonObject) => unknown>,
  tabs: ConnectedTab[] = [],
): ScriptedContext {
  const calls: RecordedCall[] = [];
  let current = [...tabs];
  const listeners = new Set<{ tabId: number; listener: CdpListener }>();
  const removalListeners = new Set<(tabId: number) => void>();
  const base = makeContext();
  return {
    ...base,
    calls,
    listTabs: () => current,
    sendCommand: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unscripted CDP method: ${method}`);
      return (await handler(params)) as JsonValue;
    },
    subscribe: (tabId, listener) => {
      const entry = { tabId, listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    onTabRemoved: (listener) => {
      removalListeners.add(listener);
      return () => {
        removalListeners.delete(listener);
      };
    },
    emit: (tabId, method, params) => {
      for (const entry of [...listeners]) {
        if (entry.tabId === tabId) entry.listener(method, params);
      }
    },
    removeTab: (tabId) => {
      current = current.filter((tab) => tab.tabId !== tabId);
      for (const listener of [...removalListeners]) listener(tabId);
    },
  };
}
