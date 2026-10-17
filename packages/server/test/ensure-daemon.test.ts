import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDaemon } from "../src/client/ensure-daemon";
import { resolvePaths } from "../src/config";
import { IpcServer } from "../src/daemon/ipc-server";
import { PairingCodes } from "../src/daemon/token-store";
import { StubBackend, startInProcessDaemon } from "./helpers/in-process-daemon";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function newServer(): IpcServer {
  return new IpcServer({
    backend: new StubBackend(),
    pairing: new PairingCodes(),
    daemonVersion: "1",
    port: 1,
    rotateToken: () => Promise.resolve(),
    onShutdown: () => undefined,
  });
}

describe("ensureDaemon", () => {
  it("does nothing when a daemon already answers", async () => {
    const daemon = await startInProcessDaemon();
    cleanups.push(() => daemon.stop());
    const spawnDaemon = vi.fn();
    await ensureDaemon(daemon.paths, "entry.js", { spawnDaemon });
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("spawns once when two callers race and waits until the endpoint answers", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await mkdir(home, { recursive: true });
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    let server: IpcServer | undefined;
    cleanups.push(async () => {
      await server?.close();
    });
    const spawnDaemon = vi.fn(() => {
      setTimeout(() => {
        server = newServer();
        void server.listen(paths.ipcEndpoint);
      }, 100);
    });
    await Promise.all([
      ensureDaemon(paths, "entry.js", { spawnDaemon }),
      ensureDaemon(paths, "entry.js", { spawnDaemon }),
    ]);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection(paths.ipcEndpoint);
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", reject);
    });
  });

  it("recovers from a stale start lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    const { writeFile, utimes } = await import("node:fs/promises");
    await writeFile(paths.lockFile, "stale");
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lockFile, old, old);
    let server: IpcServer | undefined;
    cleanups.push(async () => {
      await server?.close();
    });
    const spawnDaemon = vi.fn(() => {
      server = newServer();
      void server.listen(paths.ipcEndpoint);
    });
    await ensureDaemon(paths, "entry.js", { spawnDaemon, lockStaleMs: 15_000 });
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it("times out with an actionable error when the daemon never comes up", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    await expect(
      ensureDaemon(paths, "entry.js", { spawnDaemon: () => undefined, startupTimeoutMs: 300 }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      hint: expect.stringContaining("daemon.log") as string,
    });
  });
});
