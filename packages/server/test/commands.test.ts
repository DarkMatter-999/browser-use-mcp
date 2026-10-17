import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/client/daemon-client";
import { resolvePaths } from "../src/config";
import { type Io, run } from "../src/main";
import { startInProcessDaemon } from "./helpers/in-process-daemon";

type Daemon = Awaited<ReturnType<typeof startInProcessDaemon>>;
let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, text: () => out.join(""), errText: () => err.join("") };
}
const noAutostart = (options: Parameters<typeof DaemonClient.connect>[0]) =>
  DaemonClient.connect({ ...options, autostart: false });
const deps = (d: Daemon) => ({ paths: d.paths, connect: noAutostart });

describe("pair", () => {
  it("prints a formatted pairing code from the daemon", async () => {
    daemon = await startInProcessDaemon();
    const c = capture();
    expect(await run(["pair"], c.io, deps(daemon))).toBe(0);
    expect(c.text()).toMatch(
      /Enter this code in the Browser Use extension popup: [A-Z2-9]{4}-[A-Z2-9]{4}/,
    );
    expect(c.text()).toContain("expires in 5 minutes");
  });

  it("--reset rotates the token first", async () => {
    daemon = await startInProcessDaemon();
    const c = capture();
    await run(["pair", "--reset"], c.io, deps(daemon));
    expect(daemon.rotations).toBe(1);
    expect(c.text()).toContain("Token rotated");
  });
});

describe("status", () => {
  it("prints daemon, extension and tabs", async () => {
    daemon = await startInProcessDaemon();
    daemon.backend.tabs = [{ tabId: 5, url: "https://a/", title: "A" }];
    const c = capture();
    expect(await run(["status"], c.io, deps(daemon))).toBe(0);
    expect(c.text()).toMatch(/Daemon: running \(v1\.0\.0, pid \d+\)/);
    expect(c.text()).toContain("Extension: connected");
    expect(c.text()).toContain("5");
  });

  it("explains that a disconnected extension is expected while no tabs are connected", async () => {
    daemon = await startInProcessDaemon();
    daemon.backend.connected = false;
    const c = capture();
    expect(await run(["status"], c.io, deps(daemon))).toBe(0);
    expect(c.text()).toMatch(/Extension: not connected \(it connects while a tab is connected/);
  });

  it("--json prints the status object", async () => {
    daemon = await startInProcessDaemon();
    const c = capture();
    await run(["status", "--json"], c.io, deps(daemon));
    expect(JSON.parse(c.text())).toMatchObject({ mode: "extension", daemonVersion: "1.0.0" });
  });

  it("says the daemon is not running (exit 0) when nothing listens", async () => {
    daemon = await startInProcessDaemon();
    const paths = daemon.paths;
    await daemon.server.close();
    const c = capture();
    expect(await run(["status"], c.io, { paths, connect: noAutostart })).toBe(0);
    expect(c.text()).toContain("Daemon: not running");
  });
});

describe("stop", () => {
  it("shuts the daemon down", async () => {
    daemon = await startInProcessDaemon();
    const c = capture();
    expect(await run(["stop"], c.io, deps(daemon))).toBe(0);
    expect(c.text()).toContain("Daemon stopped.");
    expect(daemon.shutdowns).toBe(1);
  });

  it("is a no-op when not running", async () => {
    daemon = await startInProcessDaemon();
    const paths = daemon.paths;
    await daemon.server.close();
    const c = capture();
    await run(["stop"], c.io, { paths, connect: noAutostart });
    expect(c.text()).toContain("Daemon was not running.");
  });
});

describe("doctor", () => {
  it("reports ok for a running daemon and flags a missing extension connection", async () => {
    daemon = await startInProcessDaemon();
    daemon.backend.connected = false;
    const c = capture();
    const code = await run(["doctor"], c.io, deps(daemon));
    expect(c.text()).toMatch(/ok\s+node/);
    expect(c.text()).toMatch(/ok\s+daemon/);
    expect(c.text()).toMatch(
      /warn\s+extension\s+not connected \(normal while no tabs are connected\)/,
    );
    expect(c.text()).toMatch(
      /fix: Connect a tab from the Browser Use popup.*Let the agent open tabs/,
    );
    expect(c.text()).not.toMatch(/fail\s+extension/);
    expect(code).toBe(0);
  });

  it("fails (exit 1) with a fix when the state dir is unusable", async () => {
    daemon = await startInProcessDaemon();
    const bad = { ...daemon.paths, home: "/proc/definitely-not-writable/bu" };
    const c = capture();
    const code = await run(["doctor"], c.io, { paths: bad, connect: noAutostart });
    expect(c.text()).toMatch(/fail\s+state-dir/);
    expect(code).toBe(1);
  });

  it("fails when something else owns the bridge port and no daemon runs", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const home = await mkdtemp(join(tmpdir(), "bu-"));
    const c = capture();
    const code = await run(["doctor"], c.io, {
      paths: resolvePaths({ BROWSER_USE_HOME: home }),
      env: { BROWSER_USE_PORT: String(port) },
      connect: noAutostart,
    });
    expect(c.text()).toMatch(/fail\s+port/);
    expect(c.text()).toContain("BROWSER_USE_PORT");
    expect(code).toBe(1);
    blocker.close();
    await rm(home, { recursive: true, force: true });
  });
});

describe("daemon command", () => {
  it("invokes the injected runDaemon", async () => {
    let started = false;
    const c = capture();
    const code = await run(["daemon"], c.io, {
      runDaemon: () => {
        started = true;
        return Promise.resolve();
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(true);
  });
});

describe("unknown command", () => {
  it("exits 2", async () => {
    const c = capture();
    expect(await run(["bogus"], c.io)).toBe(2);
    expect(c.errText()).toContain("Unknown command: bogus");
  });
});
