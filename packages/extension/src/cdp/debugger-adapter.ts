import "../zod-jitless";
import { BrowserUseError } from "@browser-use/protocol";
import { isAllowedMethod, needsContext, type ValidationContext, validateParams } from "./allowlist";

export interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  onDetach: {
    addListener(listener: (source: { tabId?: number }) => void): void;
    removeListener(listener: (source: { tabId?: number }) => void): void;
  };
  getTargets(): Promise<{ tabId?: number; attached: boolean }[]>;
}

const RESTRICTED_HINT =
  "Chrome does not allow debugging this page (restricted or browser-internal pages cannot be connected).";

function noop(): void {
  return undefined;
}

export class DebuggerAdapter {
  private readonly attached = new Set<number>();
  private readonly listener: (source: { tabId?: number }) => void;
  private readonly api: DebuggerApi;

  /**
   * @param contextFor resolves the tab URL and file-access setting for URL-scoped methods
   *   (Page.navigate, cookie methods). Without it those methods are refused (fail closed).
   */
  constructor(
    api?: DebuggerApi,
    private readonly onExternalDetach: (tabId: number) => void = noop,
    private readonly contextFor?: (tabId: number) => Promise<ValidationContext>,
  ) {
    this.api = api ?? chrome.debugger;
    this.listener = (source) => {
      if (source.tabId !== undefined && this.attached.delete(source.tabId)) {
        this.onExternalDetach(source.tabId);
      }
    };
    this.api.onDetach.addListener(this.listener);
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    try {
      await this.api.attach({ tabId }, "1.3");
    } catch (error) {
      throw this.mapError(error);
    }
    this.attached.add(tabId);
    try {
      await this.api.sendCommand({ tabId }, "Runtime.enable", {});
      await this.api.sendCommand({ tabId }, "Page.enable", {});
    } catch (error) {
      this.attached.delete(tabId);
      try {
        await this.api.detach({ tabId });
      } catch {
        /* best effort cleanup after failed initialization */
      }
      throw this.mapError(error);
    }
  }

  /**
   * After a service-worker restart, re-adopts debugger sessions that survived it: of `tabIds`
   * (the tabs this extension had connected), those Chrome still reports as attached. Each one
   * must answer Runtime.enable/Page.enable on this extension's session; a tab attached by
   * someone else (DevTools) fails that and is skipped. Returns the adopted tab ids.
   */
  async reattach(tabIds: readonly number[]): Promise<number[]> {
    const targets = await this.api.getTargets();
    const live = new Set(targets.filter((target) => target.attached).map((target) => target.tabId));
    const adopted: number[] = [];
    for (const tabId of tabIds) {
      if (!live.has(tabId)) continue;
      if (this.attached.has(tabId)) {
        adopted.push(tabId);
        continue;
      }
      this.attached.add(tabId);
      try {
        await this.api.sendCommand({ tabId }, "Runtime.enable", {});
        await this.api.sendCommand({ tabId }, "Page.enable", {});
        adopted.push(tabId);
      } catch {
        this.attached.delete(tabId);
      }
    }
    return adopted;
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!isAllowedMethod(method)) {
      throw new BrowserUseError("UNSUPPORTED_CDP_METHOD", `Unsupported CDP method: ${method}`);
    }
    if (!this.attached.has(tabId)) {
      throw new BrowserUseError("TAB_NOT_CONNECTED", `Tab ${tabId} is not attached`);
    }
    let context: ValidationContext | undefined;
    if (needsContext(method) && this.contextFor) {
      try {
        context = await this.contextFor(tabId);
      } catch (error) {
        throw this.mapError(error);
      }
    }
    const invalid = validateParams(method, params, context);
    if (invalid !== undefined) throw new BrowserUseError("INVALID_ARGUMENT", invalid);
    try {
      return await this.api.sendCommand({ tabId }, method, params);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    try {
      await this.api.detach({ tabId });
    } catch (error) {
      if (!/not attached/i.test(String(error))) throw error;
    }
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  attachedTabs(): number[] {
    return [...this.attached];
  }

  dispose(): void {
    this.api.onDetach.removeListener(this.listener);
  }

  private mapError(error: unknown): BrowserUseError {
    if (error instanceof BrowserUseError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/permission|cannot access|restricted|not allowed|denied/i.test(message)) {
      return new BrowserUseError("INTERNAL", message, { hint: RESTRICTED_HINT, cause: error });
    }
    return new BrowserUseError("INTERNAL", message, { cause: error });
  }
}
