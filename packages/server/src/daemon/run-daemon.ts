import { mkdir, unlink } from "node:fs/promises";
import { BrowserUseError } from "@browser-use/protocol";
import pkg from "../../package.json" with { type: "json" };
import { canConnect, isPipe } from "../client/ensure-daemon";
import { resolveExtensionId, resolvePaths, resolvePort } from "../config";
import { BridgeServer } from "./bridge-server";
import { ExtensionBackend } from "./extension-backend";
import { IdleMonitor } from "./idle-monitor";
import { IpcServer } from "./ipc-server";
import { createLogger } from "./log";
import {
  FailureLimiter,
  loadOrCreateToken,
  PairingCodes,
  resetToken,
  tokensEqual,
} from "./token-store";

const IDLE_MS = 15 * 60_000;

export async function runDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = resolvePaths(env);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const log = createLogger(paths.logFile);
  const port = resolvePort(env);
  let token = await loadOrCreateToken(paths);
  const pairing = new PairingCodes();
  const limiter = new FailureLimiter();

  const bridge = new BridgeServer({
    port,
    extensionId: resolveExtensionId(env),
    daemonVersion: pkg.version,
    auth: {
      verifyToken: (candidate) => tokensEqual(candidate, token),
      consumePairingCode: (code) => (pairing.consume(code) ? token : undefined),
      limiter,
    },
  });
  const backend = new ExtensionBackend(bridge);
  let shuttingDown = false;

  async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    idle.stop();
    await ipc.close();
    await bridge.close();
    await log.info("daemon stopped");
    process.exit(code);
  }

  const ipc = new IpcServer({
    backend,
    pairing,
    daemonVersion: pkg.version,
    port,
    rotateToken: async () => {
      token = await resetToken(paths);
      bridge.disconnectPeer();
    },
    onShutdown: () => void shutdown(0),
  });

  if (await canConnect(paths.ipcEndpoint)) {
    await log.info("another daemon is already running; exiting");
    return;
  }
  try {
    if (!isPipe(paths.ipcEndpoint)) await unlink(paths.ipcEndpoint).catch(() => undefined);
    await bridge.start();
    await ipc.listen(paths.ipcEndpoint);
  } catch (error) {
    const message =
      error instanceof BrowserUseError ? `${error.message} (${error.hint ?? ""})` : String(error);
    await log.error(`failed to start: ${message}`);
    await bridge.close().catch(() => undefined);
    process.exit(1);
  }

  const idle = new IdleMonitor({
    idleMs: IDLE_MS,
    isBusy: () => ipc.clientCount > 0 || backend.listTabs().length > 0,
    onIdle: () => void shutdown(0),
  });
  idle.start();
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    void log.error(error.stack ?? String(error)).then(() => shutdown(1));
  });
  process.on("unhandledRejection", (reason) => {
    void log.error(`unhandled rejection: ${String(reason)}`);
  });
  await log.info(`daemon ${pkg.version} listening: ipc=${paths.ipcEndpoint} ws=127.0.0.1:${port}`);
}
