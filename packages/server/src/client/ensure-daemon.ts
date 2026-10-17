import { spawn } from "node:child_process";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import net from "node:net";
import { BrowserUseError } from "@browser-use/protocol";
import type { Paths } from "../config";

export type SpawnDaemon = (entryScript: string, env: NodeJS.ProcessEnv) => void;

export interface EnsureDaemonDeps {
  spawnDaemon?: SpawnDaemon;
  lockStaleMs?: number;
  startupTimeoutMs?: number;
}

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

export async function ensureDaemon(
  paths: Paths,
  entryScript: string,
  deps: EnsureDaemonDeps = {},
): Promise<void> {
  if (await canConnect(paths.ipcEndpoint)) return;
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const lockStaleMs = deps.lockStaleMs ?? 15_000;
  const startupTimeoutMs = deps.startupTimeoutMs ?? 5_000;
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawn;
  const startupError = () =>
    new BrowserUseError("INTERNAL", "Could not start the Browser Use daemon", {
      hint: `Check ${paths.logFile} for the reason (a busy port is the usual cause), then run \`browser-use-mcp doctor\`.`,
    });

  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const deadline = Date.now() + startupTimeoutMs + lockStaleMs;
  while (!lock && Date.now() < deadline) {
    try {
      lock = await open(paths.lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await canConnect(paths.ipcEndpoint)) return;
      const info = await stat(paths.lockFile).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > lockStaleMs) {
        await unlink(paths.lockFile).catch(() => undefined);
      }
      await sleep(50);
    }
  }
  if (!lock) throw startupError();

  try {
    if (await canConnect(paths.ipcEndpoint)) return;
    // The connect just failed, so any socket file is stale; never unlink a live one.
    if (!isPipe(paths.ipcEndpoint)) await unlink(paths.ipcEndpoint).catch(() => undefined);
    spawnDaemon(entryScript, process.env);
    const until = Date.now() + startupTimeoutMs;
    while (Date.now() < until) {
      if (await canConnect(paths.ipcEndpoint)) return;
      await sleep(50);
    }
    throw startupError();
  } finally {
    await lock.close();
    await unlink(paths.lockFile).catch(() => undefined);
  }
}
