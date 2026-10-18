import { access, constants, readFile, stat } from "node:fs/promises";
import net from "node:net";
import {
  resolveBrowserConfig,
  resolveExtensionId,
  resolvePort,
  type BrowserConfig,
} from "../config";
import { discoverBrowser } from "../daemon/browser-discovery";
import { type CommandContext, connectExisting } from "./context";

type Level = "ok" | "warn" | "fail";

interface Check {
  level: Level;
  name: string;
  detail: string;
  fix?: string;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(true);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(false);
      });
    });
  });
}

async function checkStateDir(ctx: CommandContext): Promise<Check> {
  const name = "state-dir";
  try {
    const info = await stat(ctx.paths.home);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(ctx.paths.home, constants.W_OK);
    return { level: "ok", name, detail: ctx.paths.home };
  } catch {
    return {
      level: "fail",
      name,
      detail: `${ctx.paths.home} is missing or not writable`,
      fix: "Create it and make it writable, or set BROWSER_USE_HOME to a writable directory.",
    };
  }
}

async function checkToken(ctx: CommandContext): Promise<Check> {
  const name = "token";
  let raw: string;
  try {
    raw = (await readFile(ctx.paths.tokenFile, "utf8")).trim();
  } catch {
    return { level: "warn", name, detail: "no token file yet (created on first daemon start)" };
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return { level: "ok", name, detail: ctx.paths.tokenFile };
  return {
    level: "fail",
    name,
    detail: "token file is not 64 hex characters",
    fix: "Run `browseruse-mcp pair --reset` to generate a new token.",
  };
}

async function checkBrowser(ctx: CommandContext, config: BrowserConfig): Promise<Check> {
  try {
    const env =
      config.executablePath === undefined
        ? ctx.env
        : { ...ctx.env, BROWSER_USE_CHROME_PATH: config.executablePath };
    const browser = await discoverBrowser(process.platform, env);
    return {
      level: "ok",
      name: "browser",
      detail: `${browser.browserName} (${browser.executablePath})`,
    };
  } catch (error) {
    return {
      level: "fail",
      name: "browser",
      detail: error instanceof Error ? error.message : String(error),
      fix:
        error && typeof error === "object" && "hint" in error && typeof error.hint === "string"
          ? error.hint
          : "Install Chrome, Chromium, Edge, or Brave, or set BROWSER_USE_CHROME_PATH.",
    };
  }
}

export async function runDoctor(ctx: CommandContext): Promise<number> {
  const checks: Check[] = [];
  let browserConfig: BrowserConfig;
  try {
    browserConfig = resolveBrowserConfig(ctx.env);
  } catch (error) {
    checks.push({
      level: "fail",
      name: "browser-config",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Set BROWSER_USE_MODE to extension, headless, or auto and BROWSER_USE_PROFILE to default or guest.",
    });
    browserConfig = { mode: "extension", profile: "default" };
  }
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    major >= 20
      ? { level: "ok", name: "node", detail: `v${process.versions.node}` }
      : {
          level: "fail",
          name: "node",
          detail: `v${process.versions.node} is too old`,
          fix: "Install Node.js 20 or newer.",
        },
  );
  checks.push(await checkStateDir(ctx));
  checks.push(await checkToken(ctx));
  if (browserConfig.mode !== "extension") checks.push(await checkBrowser(ctx, browserConfig));

  const client = await connectExisting(ctx);
  let status: Awaited<ReturnType<NonNullable<typeof client>["status"]>> | undefined;
  if (client) {
    try {
      status = await client.status();
    } catch {
      status = undefined;
    } finally {
      client.close();
    }
  }
  if (status) {
    checks.push({ level: "ok", name: "daemon", detail: `running (pid ${status.pid})` });
    checks.push({
      level: "ok",
      name: "browser-mode",
      detail: `${status.mode} (requested ${status.requestedMode}, profile ${status.profile})${status.browserName ? `, ${status.browserName}` : ""}`,
    });
    if (status.mode === "headless") {
      checks.push({ level: "ok", name: "extension", detail: "not used (headless mode)" });
    } else {
      checks.push(
        status.extensionConnected
          ? { level: "ok", name: "extension", detail: "connected" }
          : {
              // Expected: the extension connects only while a tab is connected or keep-connected is on.
              level: "warn",
              name: "extension",
              detail: "not connected (normal while no tabs are connected)",
              fix: 'Connect a tab from the Browser Use popup, or turn on "Let the agent open tabs" in its Settings. If the popup says Not paired, enter the code from `browseruse-mcp pair`.',
            },
      );
    }
  } else {
    checks.push({
      level: "warn",
      name: "daemon",
      detail: "not running",
      fix: "It starts automatically when an MCP client connects, or run `browseruse-mcp pair`.",
    });
    checks.push(
      browserConfig.mode === "headless"
        ? { level: "ok", name: "extension", detail: "not used in headless mode" }
        : {
            level: "warn",
            name: "extension",
            detail: "unknown (daemon not running)",
            fix: "Start the daemon with `browseruse-mcp pair`, then pair the extension.",
          },
    );
  }

  if (browserConfig.mode !== "headless") {
    let port: number | undefined;
    try {
      port = resolvePort(ctx.env);
    } catch (error) {
      checks.push({
        level: "fail",
        name: "port",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Set BROWSER_USE_PORT to a valid port number.",
      });
    }
    if (port !== undefined) {
      if (status) {
        checks.push({ level: "ok", name: "port", detail: `127.0.0.1:${status.port} (daemon)` });
      } else if (await portInUse(port)) {
        checks.push({
          level: "fail",
          name: "port",
          detail: `127.0.0.1:${port} is in use by another process`,
          fix: "Free the port or set BROWSER_USE_PORT to a different one (also in the extension).",
        });
      } else {
        checks.push({ level: "ok", name: "port", detail: `127.0.0.1:${port} is free` });
      }
    }
    checks.push({ level: "ok", name: "extension-id", detail: resolveExtensionId(ctx.env) });
  }

  const lines = checks.map((check) => {
    const base = `${check.level.padEnd(5)} ${check.name.padEnd(13)} ${check.detail}`;
    return check.fix ? `${base}\n${" ".repeat(20)}fix: ${check.fix}` : base;
  });
  ctx.io.out(`${lines.join("\n")}\n`);
  return checks.some((check) => check.level === "fail") ? 1 : 0;
}
