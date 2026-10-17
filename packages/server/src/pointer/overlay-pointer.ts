import type { DaemonApi } from "../mcp/context";
import { OVERLAY_SCRIPT } from "./overlay-script";
import type { Pointer } from "./types";

type PointerApi = Pick<DaemonApi, "sendCommand" | "subscribe" | "onTabRemoved">;
const MAX_LABEL = 80;

export class OverlayPointer implements Pointer {
  readonly #installed = new Set<number>();

  constructor(
    private readonly api: PointerApi,
    readonly enabled: boolean,
  ) {}

  async ensureInstalled(tabId: number): Promise<void> {
    if (!this.enabled) return;
    if (!this.#installed.has(tabId)) {
      await this.api.sendCommand(tabId, "Page.addScriptToEvaluateOnNewDocument", {
        source: OVERLAY_SCRIPT,
      });
      this.#installed.add(tabId);
      const stop = this.api.onTabRemoved((removed) => {
        if (removed === tabId) {
          this.#installed.delete(tabId);
          stop();
        }
      });
    }
    await this.api.sendCommand(tabId, "Runtime.evaluate", {
      expression: OVERLAY_SCRIPT,
      returnByValue: true,
    });
  }

  async moveTo(tabId: number, x: number, y: number, label: string): Promise<void> {
    if (!this.enabled || !Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      await this.ensureInstalled(tabId);
      const text = JSON.stringify(label.slice(0, MAX_LABEL));
      await this.api.sendCommand(tabId, "Runtime.evaluate", {
        expression: `window.__browserUseOverlay&&window.__browserUseOverlay.moveTo(${Math.round(x)},${Math.round(y)},${text})`,
      });
    } catch {
      /* the overlay is a courtesy: never fail an action because of it */
    }
  }

  async hideForCapture(tabId: number): Promise<() => Promise<void>> {
    if (!this.enabled) return () => Promise.resolve();
    const call = async (method: "hide" | "show"): Promise<void> => {
      try {
        await this.api.sendCommand(tabId, "Runtime.evaluate", {
          expression: `window.__browserUseOverlay&&window.__browserUseOverlay.${method}()`,
        });
      } catch {
        /* ignore */
      }
    };
    await call("hide");
    return () => call("show");
  }
}
