import type { ToolContext } from "../mcp/context";

export interface PendingChooser {
  backendNodeId: number;
  multiple: boolean;
}

interface TabWatch {
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Fires when an unanswered chooser expires. */
  expiry?: ReturnType<typeof setTimeout>;
  pending?: PendingChooser;
}

/** How long an intercepted, unanswered file chooser stays usable by browser_upload. */
export const PENDING_CHOOSER_TTL_MS = 60_000;

/**
 * While armed, Chrome sends file choosers in the tab to CDP instead of opening the native
 * dialog. Interception therefore never outlives its purpose: it is turned off when nothing
 * opens within the arm window, when an intercepted chooser is used or cleared, when it goes
 * unanswered for `pendingTtlMs`, or when the main frame navigates (the chooser's node is gone).
 * Otherwise the user's own clicks on file inputs in a connected tab would silently do nothing.
 */
export class ChooserWatch {
  readonly #tabs = new Map<number, TabWatch>();
  #ctx: ToolContext | undefined;

  constructor(private readonly pendingTtlMs = PENDING_CHOOSER_TTL_MS) {}

  async armFor(ctx: ToolContext, tabId: number, ms = 3000): Promise<void> {
    this.#ctx = ctx;
    let watch = this.#tabs.get(tabId);
    if (!watch) {
      const created: TabWatch = {
        unsubscribe: ctx.subscribe(tabId, (method, params) => {
          if (method === "Page.frameNavigated") {
            const frame = params.frame;
            const isMain =
              typeof frame === "object" &&
              frame !== null &&
              !Array.isArray(frame) &&
              !("parentId" in frame);
            if (isMain && created.pending) this.#release(tabId);
            return;
          }
          if (method !== "Page.fileChooserOpened") return;
          const data = params as { backendNodeId?: unknown; mode?: unknown } | null;
          if (typeof data?.backendNodeId !== "number") return;
          created.pending = {
            backendNodeId: data.backendNodeId,
            multiple: data.mode === "selectMultiple",
          };
          if (created.expiry) clearTimeout(created.expiry);
          created.expiry = setTimeout(() => {
            created.expiry = undefined;
            if (this.#tabs.get(tabId) === created) this.#release(tabId);
          }, this.pendingTtlMs);
        }),
      };
      watch = created;
      this.#tabs.set(tabId, watch);
      try {
        await ctx.sendCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
      } catch (error) {
        created.unsubscribe();
        this.#tabs.delete(tabId);
        throw error;
      }
    }
    if (watch.timer) clearTimeout(watch.timer);
    const current = watch;
    current.timer = setTimeout(() => {
      current.timer = undefined;
      if (!current.pending) this.#release(tabId);
    }, ms);
  }

  peek(tabId: number): PendingChooser | undefined {
    return this.#tabs.get(tabId)?.pending;
  }

  take(tabId: number): PendingChooser | undefined {
    const pending = this.#tabs.get(tabId)?.pending;
    if (pending) this.clear(tabId);
    return pending;
  }

  clear(tabId: number): void {
    const watch = this.#tabs.get(tabId);
    if (!watch) return;
    watch.pending = undefined;
    if (!watch.timer) this.#release(tabId);
  }

  #release(tabId: number): void {
    const watch = this.#tabs.get(tabId);
    if (!watch) return;
    this.#tabs.delete(tabId);
    if (watch.timer) clearTimeout(watch.timer);
    if (watch.expiry) clearTimeout(watch.expiry);
    watch.unsubscribe();
    void this.#ctx
      ?.sendCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: false })
      .catch(() => undefined);
  }
}

const watches = new WeakMap<ToolContext, ChooserWatch>();

export function chooserWatchFor(ctx: ToolContext): ChooserWatch {
  let watch = watches.get(ctx);
  if (!watch) {
    watch = new ChooserWatch();
    watches.set(ctx, watch);
  }
  return watch;
}

/** Module-level facade; state is kept per ToolContext. */
export const chooserWatch = {
  armFor: (ctx: ToolContext, tabId: number, ms?: number) =>
    chooserWatchFor(ctx).armFor(ctx, tabId, ms),
  peek: (ctx: ToolContext, tabId: number) => chooserWatchFor(ctx).peek(tabId),
  take: (ctx: ToolContext, tabId: number) => chooserWatchFor(ctx).take(tabId),
  clear: (ctx: ToolContext, tabId: number): void => {
    chooserWatchFor(ctx).clear(tabId);
  },
};
