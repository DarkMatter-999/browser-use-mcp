import "../zod-jitless";
import { BrowserUseError } from "@browser-use/protocol";
import { isAllowedMethod, validateParams } from "./allowlist";

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

  constructor(
    api?: DebuggerApi,
    private readonly onExternalDetach: (tabId: number) => void = noop,
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
    const invalid = validateParams(method, params);
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
