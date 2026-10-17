import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client/daemon-client";
import { startInProcessDaemon } from "./helpers/in-process-daemon";

type Daemon = Awaited<ReturnType<typeof startInProcessDaemon>>;
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await daemon?.stop();
  daemon = undefined;
});

async function connect(clientVersion = "1.0.0") {
  daemon = await startInProcessDaemon("1.0.0");
  client = await DaemonClient.connect({
    paths: daemon.paths,
    clientVersion,
    entryScript: "unused",
    autostart: false,
  });
  return { daemon, client };
}

describe("DaemonClient", () => {
  it("fails fast without autostart when no daemon is listening", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolvePaths } = await import("../src/config");
    const paths = resolvePaths({ BROWSER_USE_HOME: await mkdtemp(join(tmpdir(), "bu-")) });
    await expect(
      DaemonClient.connect({ paths, clientVersion: "1", entryScript: "x", autostart: false }),
    ).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
  });

  it("keeps listTabs fresh from pushed state and exposes status", async () => {
    const { daemon, client } = await connect();
    daemon.backend.tabs = [{ tabId: 4, url: "https://a/", title: "A" }];
    daemon.backend.emitTabs();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.listTabs().map((t) => t.tabId)).toEqual([4]);
    expect(await client.status()).toMatchObject({ extensionConnected: true });
  });

  it("round-trips sendCommand and propagates typed errors", async () => {
    const { daemon, client } = await connect();
    expect(await client.sendCommand(1, "Runtime.evaluate", { expression: "1" })).toEqual({
      echoed: "Runtime.evaluate",
    });
    const { BrowserUseError } = await import("@browser-use/protocol");
    daemon.backend.sendCommand = () =>
      Promise.reject(new BrowserUseError("STALE_REF", "stale", { hint: "snapshot again" }));
    await expect(client.sendCommand(1, "DOM.getBoxModel", {})).rejects.toMatchObject({
      code: "STALE_REF",
      hint: "snapshot again",
    });
  });

  it("delivers subscribed events and removal notifications", async () => {
    const { daemon, client } = await connect();
    const seen: string[] = [];
    const removed: number[] = [];
    const stop = client.subscribe(2, (method) => seen.push(method));
    client.onTabRemoved((tabId) => removed.push(tabId));
    await new Promise((r) => setTimeout(r, 50));
    daemon.backend.emitEvent(2, "Page.loadEventFired", {});
    for (const l of daemon.backend.removedListeners) l(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["Page.loadEventFired"]);
    expect(removed).toEqual([2]);
    stop();
  });

  it("restarts an older daemon once when the client is newer", async () => {
    daemon = await startInProcessDaemon("1.0.0", { closeOnShutdown: true });
    const old = daemon;
    const { paths } = old;
    let replacement: Daemon | undefined;
    const spawnDaemon = vi.fn(() => {
      void startInProcessDaemon("2.0.0", { paths }).then((started) => {
        replacement = started;
      });
    });
    client = await DaemonClient.connect({
      paths,
      clientVersion: "2.0.0",
      entryScript: "x",
      spawnDaemon,
    });
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(old.shutdowns).toBe(1);
    expect((await client.status()).daemonVersion).toBe("2.0.0");
    client.close();
    client = undefined;
    await replacement?.stop();
  });

  it("accepts a newer daemon without restarting it", async () => {
    daemon = await startInProcessDaemon("3.0.0");
    const spawnDaemon = vi.fn();
    client = await DaemonClient.connect({
      paths: daemon.paths,
      clientVersion: "1.0.0",
      entryScript: "x",
      spawnDaemon,
    });
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(daemon.shutdowns).toBe(0);
  });

  it("reconnects transparently after the daemon restarts", async () => {
    const first = await startInProcessDaemon("1.0.0");
    daemon = first;
    client = await DaemonClient.connect({
      paths: first.paths,
      clientVersion: "1.0.0",
      entryScript: "x",
      autostart: false,
    });
    await first.server.close();
    await new Promise((r) => setTimeout(r, 50));
    const second = await startInProcessDaemon("1.0.0", { paths: first.paths });
    try {
      second.backend.tabs = [{ tabId: 8, url: "https://b/", title: "B" }];
      expect((await client.status()).extensionConnected).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.listTabs().map((t) => t.tabId)).toEqual([8]);
    } finally {
      await second.stop();
    }
  });

  it("rejects pending requests with BRIDGE_DISCONNECTED when the daemon goes away", async () => {
    const { daemon, client } = await connect();
    daemon.backend.sendCommand = () => new Promise(() => undefined);
    const pending = client.sendCommand(1, "Runtime.evaluate", {});
    const failed = expect(pending).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
    await daemon.server.close();
    await failed;
  });

  it("rejects instead of hanging when the socket closes before helloAck", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolvePaths } = await import("../src/config");
    const paths = resolvePaths({ BROWSER_USE_HOME: await mkdtemp(join(tmpdir(), "bu-")) });
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(paths.ipcEndpoint, resolve));
    try {
      await expect(
        DaemonClient.connect({ paths, clientVersion: "1", entryScript: "x", autostart: false }),
      ).rejects.toMatchObject({ code: "BRIDGE_DISCONNECTED" });
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
