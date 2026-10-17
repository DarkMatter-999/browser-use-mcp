import { BrowserUseError, type JsonObject } from "@browser-use/protocol";
import type { DaemonApi } from "../mcp/context";
import type { RefStore } from "./types";

const staleError = (message: string): BrowserUseError =>
  new BrowserUseError("STALE_REF", message, {
    hint: "Call browser_snapshot again for this tab and use the new refs. Refs expire when the page navigates or a new snapshot is taken.",
  });

export class InMemoryRefStore implements RefStore {
  readonly #tabs = new Map<number, ReadonlyMap<string, number>>();

  set(tabId: number, refs: ReadonlyMap<string, number>): void {
    this.#tabs.set(tabId, refs);
  }

  has(tabId: number): boolean {
    return this.#tabs.has(tabId);
  }

  invalidate(tabId: number): void {
    this.#tabs.delete(tabId);
  }

  resolve(tabId: number, ref: string): number {
    const refs = this.#tabs.get(tabId);
    if (!refs) {
      throw staleError(
        `There is no current snapshot for tab ${tabId} (none was taken, or the page navigated).`,
      );
    }
    const backendNodeId = refs.get(ref);
    if (backendNodeId === undefined) {
      throw staleError(`Ref ${ref} is not part of the current snapshot of tab ${tabId}.`);
    }
    return backendNodeId;
  }
}

export function watchNavigation(
  api: Pick<DaemonApi, "subscribe" | "onTabRemoved">,
  refs: RefStore,
  tabId: number,
): () => void {
  const stopEvents = api.subscribe(tabId, (method: string, params: JsonObject) => {
    if (method !== "Page.frameNavigated") return;
    const frame = params.frame;
    if (
      typeof frame === "object" &&
      frame !== null &&
      !Array.isArray(frame) &&
      !("parentId" in frame)
    ) {
      refs.invalidate(tabId);
    }
  });
  const stopRemoval = api.onTabRemoved((removed) => {
    if (removed === tabId) refs.invalidate(tabId);
  });
  return () => {
    stopEvents();
    stopRemoval();
  };
}
