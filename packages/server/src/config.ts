import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { BrowserUseError, EXTENSION_ID } from "@browser-use/protocol";

export const DEFAULT_BRIDGE_PORT = 38241;

export type BrowserMode = "extension" | "headless" | "auto";
export type BrowserProfile = "default" | "guest";

export interface BrowserConfig {
  mode: BrowserMode;
  profile: BrowserProfile;
  executablePath?: string;
}

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
  // Pick the path flavour from the requested platform, not the host, so results are deterministic.
  const { join } = platform === "win32" ? win32 : posix;
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

export function resolveBrowserConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): BrowserConfig {
  const rawMode =
    env.BROWSER_USE_MODE === undefined || env.BROWSER_USE_MODE === ""
      ? "extension"
      : env.BROWSER_USE_MODE;
  if (rawMode !== "extension" && rawMode !== "headless" && rawMode !== "auto") {
    throw new BrowserUseError(
      "INVALID_ARGUMENT",
      `BROWSER_USE_MODE must be extension, headless, or auto (got "${rawMode}")`,
    );
  }

  const rawProfile =
    env.BROWSER_USE_PROFILE === undefined || env.BROWSER_USE_PROFILE === ""
      ? "default"
      : env.BROWSER_USE_PROFILE;
  if (rawProfile !== "default" && rawProfile !== "guest") {
    throw new BrowserUseError(
      "INVALID_ARGUMENT",
      `BROWSER_USE_PROFILE must be default or guest (got "${rawProfile}")`,
    );
  }

  const rawExecutablePath = env.BROWSER_USE_CHROME_PATH?.trim();
  const pathOps = platform === "win32" ? win32 : posix;
  const executablePath = rawExecutablePath ? pathOps.resolve(cwd, rawExecutablePath) : undefined;
  return {
    mode: rawMode,
    profile: rawProfile,
    ...(executablePath ? { executablePath } : {}),
  };
}

export function resolveProfileDir(
  paths: Paths,
  profile: BrowserProfile,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (profile === "guest") return undefined;
  const { join } = platform === "win32" ? win32 : posix;
  return join(paths.home, "profile");
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
