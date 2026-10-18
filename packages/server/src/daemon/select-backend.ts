import type { BrowserConfig } from "../config";
import type { BrowserBackend } from "./backend";

export const DEFAULT_AUTO_EXTENSION_TIMEOUT_MS = 5_000;

export interface BackendSelection {
  backend: BrowserBackend;
  fallbackReason?: string;
  close(): Promise<void>;
}

export interface SelectBackendDeps {
  waitForExtension(timeoutMs: number): Promise<boolean>;
  createExtensionBackend(): Promise<BrowserBackend> | BrowserBackend;
  createLaunchBackend(): Promise<BrowserBackend>;
  autoTimeoutMs?: number;
}

export async function selectBackend(
  config: BrowserConfig,
  deps: SelectBackendDeps,
): Promise<BackendSelection> {
  let backend: BrowserBackend;
  let fallbackReason: string | undefined;
  switch (config.mode) {
    case "extension":
      backend = await deps.createExtensionBackend();
      break;
    case "headless":
      backend = await deps.createLaunchBackend();
      break;
    case "auto":
      if (await deps.waitForExtension(deps.autoTimeoutMs ?? DEFAULT_AUTO_EXTENSION_TIMEOUT_MS)) {
        backend = await deps.createExtensionBackend();
      } else {
        backend = await deps.createLaunchBackend();
        fallbackReason = "Extension unavailable at startup; selected headless mode.";
      }
      break;
  }

  let closed = false;
  return {
    backend,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    close: async () => {
      if (closed) return;
      closed = true;
      await backend.close();
    },
  };
}

export interface ExtensionReadinessSource {
  readonly peer: unknown;
  on(event: "ready", listener: () => void): unknown;
  off(event: "ready", listener: () => void): unknown;
}

export interface BridgeLifecycle extends ExtensionReadinessSource {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function waitForExtension(
  bridge: ExtensionReadinessSource,
  timeoutMs: number,
): Promise<boolean> {
  if (bridge.peer) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bridge.off("ready", onReady);
      resolve(ready);
    };
    const onReady = (): void => {
      finish(true);
    };
    const timer = setTimeout(() => {
      finish(Boolean(bridge.peer));
    }, timeoutMs);
    bridge.on("ready", onReady);
    if (bridge.peer) finish(true);
  });
}

export interface InitializeBackendDeps extends Omit<
  SelectBackendDeps,
  "waitForExtension" | "createExtensionBackend"
> {
  createBridge(): BridgeLifecycle;
  waitForExtension?(timeoutMs: number): Promise<boolean>;
  createExtensionBackend(bridge: BridgeLifecycle): Promise<BrowserBackend> | BrowserBackend;
}

/** Starts the bridge only for extension/auto modes and owns the selected backend lifecycle. */
export async function initializeBrowserBackend(
  config: BrowserConfig,
  deps: InitializeBackendDeps,
): Promise<BackendSelection> {
  let bridge: BridgeLifecycle | undefined;
  let selected: BackendSelection | undefined;
  try {
    if (config.mode !== "headless") {
      bridge = deps.createBridge();
      await bridge.start();
    }
    selected = await selectBackend(config, {
      autoTimeoutMs: deps.autoTimeoutMs,
      waitForExtension: (timeoutMs) =>
        deps.waitForExtension
          ? deps.waitForExtension(timeoutMs)
          : bridge
            ? waitForExtension(bridge, timeoutMs)
            : Promise.resolve(false),
      createExtensionBackend: () => {
        if (!bridge) throw new Error("Extension backend selected without a bridge");
        return deps.createExtensionBackend(bridge);
      },
      createLaunchBackend: async () => {
        if (config.mode === "auto" && bridge) {
          const unusedBridge = bridge;
          bridge = undefined;
          await unusedBridge.close();
        }
        return deps.createLaunchBackend();
      },
    });
    if (selected.backend.kind === "headless" && bridge) {
      await bridge.close();
      bridge = undefined;
    }
    const selection = selected;
    const activeBridge = bridge;
    let closed = false;
    return {
      ...selection,
      close: async () => {
        if (closed) return;
        closed = true;
        await selection.close();
        await activeBridge?.close();
      },
    };
  } catch (error) {
    await selected?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}
