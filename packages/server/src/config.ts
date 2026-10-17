import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserUseError, EXTENSION_ID } from "@browser-use/protocol";

export const DEFAULT_BRIDGE_PORT = 38241;

export interface Paths {
  home: string;
  tokenFile: string;
  logFile: string;
  lockFile: string;
  ipcEndpoint: string;
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Paths {
  const home = env.BROWSER_USE_HOME ?? join(homedir(), ".browser-use");
  const ipcEndpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\browser-use-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`
      : join(home, "daemon.sock");
  return {
    home,
    tokenFile: join(home, "token"),
    logFile: join(home, "daemon.log"),
    lockFile: join(home, "daemon-start.lock"),
    ipcEndpoint,
  };
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BROWSER_USE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_BRIDGE_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrowserUseError(
      "INVALID_ARGUMENT",
      `BROWSER_USE_PORT must be an integer between 1 and 65535 (got "${raw}")`,
    );
  }
  return port;
}

export function resolveExtensionId(env: NodeJS.ProcessEnv = process.env): string {
  return env.BROWSER_USE_EXTENSION_ID ?? EXTENSION_ID;
}

export function pointerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BROWSER_USE_POINTER !== "0";
}
