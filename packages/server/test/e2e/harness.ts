import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
export const serverDir = resolve(here, "../..");
export const repoRoot = resolve(serverDir, "../..");
export const cliPath = join(serverDir, "dist/cli.js");
export const extensionDir = join(repoRoot, "packages/extension/dist");
export const chromeBin = process.env.CHROME_BIN ?? "/usr/bin/chromium";

/** Throws when a build output the suite depends on is missing. */
export function assertBuilt(): void {
  for (const required of [cliPath, join(extensionDir, "manifest.json")]) {
    if (!existsSync(required)) throw new Error(`Missing ${required}: run pnpm build first`);
  }
}

export interface FixtureServer {
  /** Origin on 127.0.0.1, e.g. http://127.0.0.1:1234 */
  origin: string;
  /** The same server reached as localhost: a different site, so its frames are cross-origin. */
  altOrigin: string;
  close(): Promise<void>;
}

const NEXT_PAGE = "<!doctype html><title>Next</title><p>next page</p>";

export async function startFixtureServer(): Promise<FixtureServer> {
  const fixtureDir = join(here, "fixture");
  let port = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/download.txt") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        response.end("download body");
        return;
      }
      if (path === "/next.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(NEXT_PAGE);
        return;
      }
      if (path === "/cross.html") {
        // Embeds frame.html from the other host name, which makes it an out-of-process iframe.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><title>Cross</title><button>Outside frame</button>` +
            `<iframe src="http://localhost:${port}/frame.html" title="cross"></iframe>`,
        );
        return;
      }
      const name = path === "/" ? "index.html" : path.slice(1);
      if (!/^[a-z]+\.html$/.test(name)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(join(fixtureDir, name));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    altOrigin: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  return port;
}

export async function tempDir(prefix: string): Promise<string> {
  // Short base path: the daemon's Unix socket lives in BROWSER_USE_HOME (108-byte limit).
  return mkdtemp(join(existsSync("/tmp") ? "/tmp" : tmpdir(), prefix));
}

export interface LaunchedBrowser {
  context: BrowserContext;
  profileDir: string;
  close(): Promise<void>;
}

export async function launchBrowser(options: {
  extensionDir: string;
  chromeBin: string;
}): Promise<LaunchedBrowser> {
  const profileDir = await tempDir("bu-e2e-profile-");
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: options.chromeBin,
      headless: true,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${options.extensionDir}`,
        `--load-extension=${options.extensionDir}`,
        "--no-sandbox",
      ],
    });
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
  // Playwright dismisses dialogs on pages without a "dialog" listener; a no-op listener leaves
  // them pending so the product (not the test driver) handles them.
  const keepDialogs = (page: Page): void => {
    page.on("dialog", () => undefined);
  };
  context.pages().forEach(keepDialogs);
  context.on("page", keepDialogs);
  return {
    context,
    profileDir,
    close: async () => {
      await context.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

export async function extensionPage(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  return page;
}

interface RuntimeGlobal {
  chrome: {
    runtime: { sendMessage(message: unknown): Promise<unknown> };
    storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  };
}

/** Sends a popup message to the service worker from an extension page and returns the reply. */
export function popupSend(page: Page, message: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    (payload) => (globalThis as unknown as RuntimeGlobal).chrome.runtime.sendMessage(payload),
    message,
  );
}

export function setExtensionStorage(page: Page, items: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    (values) => (globalThis as unknown as RuntimeGlobal).chrome.storage.local.set(values),
    items,
  );
}

export function cli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    execFile(process.execPath, [cliPath, ...args], { env, timeout: 30_000 }, (error, stdout) => {
      if (error) fail(new Error(`browseruse-mcp ${args.join(" ")} failed: ${error.message}`));
      else done(stdout);
    });
  });
}

/** Polls `probe` until it returns a non-undefined value or the timeout elapses. */
export async function poll<T>(
  probe: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 200, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${suffix}`);
}
