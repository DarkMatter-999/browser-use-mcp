import type { ToolContext } from "../mcp/context";

export interface PendingChooser {
  backendNodeId: number;
  multiple: boolean;
}

interface TabWatch {
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
  pending?: PendingChooser;
}

export class ChooserWatch {
  readonly #tabs = new Map<number, TabWatch>();
  #ctx: ToolContext | undefined;

  async armFor(ctx: ToolContext, tabId: number, ms = 3000): Promise<void> {
    this.#ctx = ctx;
    let watch = this.#tabs.get(tabId);
    if (!watch) {
      const created: TabWatch = {
        unsubscribe: ctx.subscribe(tabId, (method, params) => {
          if (method !== "Page.fileChooserOpened") return;
          const data = params as { backendNodeId?: unknown; mode?: unknown } | null;
          if (typeof data?.backendNodeId !== "number") return;
          created.pending = {
            backendNodeId: data.backendNodeId,
            multiple: data.mode === "selectMultiple",
          };
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
