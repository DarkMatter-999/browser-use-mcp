import { spawn } from "node:child_process";
import { open, stat, unlink, utimes } from "node:fs/promises";
import net from "node:net";
import { BrowserUseError } from "@browser-use/protocol";
import type { Paths } from "../config";
import { ensurePrivateHome } from "../daemon/private-home";

export type SpawnDaemon = (entryScript: string, env: NodeJS.ProcessEnv) => void;

export interface EnsureDaemonDeps {
  spawnDaemon?: SpawnDaemon;
  lockStaleMs?: number;
  startupTimeoutMs?: number;
  /** Written into the start lock so a stuck lock can be attributed. */
  clientVersion?: string;
}

type LockHandle = Awaited<ReturnType<typeof open>>;

export function canConnect(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

const defaultSpawn: SpawnDaemon = (entryScript, env) => {
  const child = spawn(process.execPath, [entryScript, "daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

function startupError(paths: Paths): BrowserUseError {
  return new BrowserUseError("INTERNAL", "Could not start the Browser Use daemon", {
    hint: `Check ${paths.logFile} for the reason (a busy port is the usual cause), then run \`browseruse-mcp doctor\`.`,
  });
}

/**
 * Takes the exclusive start lock. With `untilRunning`, gives up (returns undefined) as soon as a
 * daemon answers, which is how a client waiting behind another client's start or restart ends
 * up on the daemon that client started instead of spawning its own.
 */
async function acquireStartLock(
  paths: Paths,
  deps: EnsureDaemonDeps,
  untilRunning: boolean,
): Promise<LockHandle | undefined> {
  const lockStaleMs = deps.lockStaleMs ?? 15_000;
  const deadline = Date.now() + (deps.startupTimeoutMs ?? 5_000) + lockStaleMs;
  while (Date.now() < deadline) {
    try {
      const lock = await open(paths.lockFile, "wx", 0o600);
      await lock
        .writeFile(JSON.stringify({ pid: process.pid, version: deps.clientVersion ?? "unknown" }))
        .catch(() => undefined);
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (untilRunning && (await canConnect(paths.ipcEndpoint))) return undefined;
      const info = await stat(paths.lockFile).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > lockStaleMs) {
        await unlink(paths.lockFile).catch(() => undefined);
      }
      await sleep(50);
    }
  }
  throw startupError(paths);
}

async function releaseStartLock(paths: Paths, lock: LockHandle): Promise<void> {
  await lock.close();
  await unlink(paths.lockFile).catch(() => undefined);
}

async function spawnAndWait(
  paths: Paths,
  entryScript: string,
  deps: EnsureDaemonDeps,
): Promise<void> {
  const startupTimeoutMs = deps.startupTimeoutMs ?? 5_000;
  // The connect just failed, so any socket file is stale; never unlink a live one.
  if (!isPipe(paths.ipcEndpoint)) await unlink(paths.ipcEndpoint).catch(() => undefined);
  (deps.spawnDaemon ?? defaultSpawn)(entryScript, process.env);
  const until = Date.now() + startupTimeoutMs;
  while (Date.now() < until) {
    if (await canConnect(paths.ipcEndpoint)) return;
    await sleep(50);
  }
  throw startupError(paths);
}

export async function ensureDaemon(
  paths: Paths,
  entryScript: string,
  deps: EnsureDaemonDeps = {},
): Promise<void> {
  if (await canConnect(paths.ipcEndpoint)) return;
  await ensurePrivateHome(paths.home);
  const lock = await acquireStartLock(paths, deps, true);
  if (!lock) return;
  try {
    if (await canConnect(paths.ipcEndpoint)) return;
    await spawnAndWait(paths, entryScript, deps);
  } finally {
    await releaseStartLock(paths, lock);
  }
}

/**
 * Replaces a running (older) daemon with this client's version (spec 4.4). The start lock is
 * held for the whole restart, so an older client that reconnects in the gap waits for the new
 * daemon instead of respawning its own old one. `shutdown` asks the daemon (over the caller's
 * existing connection, never a fresh one) to drain its in-flight requests and exit, and reports
 * whether it could ask; the lock's mtime is refreshed meanwhile so it never looks stale.
 */
export async function restartDaemon(
  paths: Paths,
  entryScript: string,
  shutdown: () => Promise<boolean>,
  deps: EnsureDaemonDeps = {},
): Promise<void> {
  await ensurePrivateHome(paths.home);
  const lockStaleMs = deps.lockStaleMs ?? 15_000;
  const lock = await acquireStartLock(paths, deps, false);
  if (!lock) return;
  const refresh = setInterval(
    () => {
      const now = new Date();
      void utimes(paths.lockFile, now, now).catch(() => undefined);
    },
    Math.max(50, Math.floor(lockStaleMs / 3)),
  );
  try {
    if (await shutdown()) {
      const until = Date.now() + (deps.startupTimeoutMs ?? 5_000);
      while ((await canConnect(paths.ipcEndpoint)) && Date.now() < until) await sleep(50);
    }
    // Still answering: it would not exit, or another client already replaced it. Use it.
    if (await canConnect(paths.ipcEndpoint)) return;
    await spawnAndWait(paths, entryScript, deps);
  } finally {
    clearInterval(refresh);
    await releaseStartLock(paths, lock);
  }
}
