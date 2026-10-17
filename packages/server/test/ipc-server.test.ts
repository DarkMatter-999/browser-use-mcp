import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startInProcessDaemon } from "./helpers/in-process-daemon";

type Daemon = Awaited<ReturnType<typeof startInProcessDaemon>>;
let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

function open(endpoint: string) {
  const socket = net.createConnection(endpoint);
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  const waiters: (() => void)[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
      for (const w of waiters.splice(0)) w();
      index = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => undefined);
  const next = async (predicate: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const hit = lines.find(predicate);
      if (hit) return hit;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const send = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);
  return { socket, send, next, lines };
}

describe("IpcServer", () => {
  it("requires hello first and acks with the daemon version", async () => {
    daemon = await startInProcessDaemon("4.5.6");
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "0.0.1" });
    expect(await c.next((m) => m.type === "helloAck")).toMatchObject({
      daemonVersion: "4.5.6",
      protocolVersion: 1,
    });
    c.socket.destroy();
  });

  it("closes the connection if a request arrives before hello", async () => {
    daemon = await startInProcessDaemon();
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "listTabs", id: 1 });
    await new Promise((resolve) => c.socket.once("close", resolve));
  });

  it("pushes tabsChanged after hello and whenever the backend reports a change", async () => {
    daemon = await startInProcessDaemon();
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    await c.next((m) => m.type === "tabsChanged");
    daemon.backend.tabs = [{ tabId: 3, url: "https://a/", title: "A" }];
    daemon.backend.emitTabs();
    await c.next((m) => m.type === "tabsChanged" && (m.tabs as unknown[]).length === 1);
    c.socket.destroy();
  });

  it("serves status, listTabs, openTab, closeTab and sendCommand", async () => {
    daemon = await startInProcessDaemon();
    daemon.backend.tabs = [{ tabId: 3, url: "https://a/", title: "A" }];
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    c.send({ type: "status", id: 1 });
    c.send({ type: "fileAccess", id: 4 });
    c.send({ type: "openTab", id: 2, url: "https://example.com/" });
    c.send({
      type: "sendCommand",
      id: 3,
      tabId: 3,
      method: "Runtime.evaluate",
      params: { expression: "1" },
      timeoutMs: 1000,
    });
    const status = await c.next((m) => m.type === "result" && m.id === 1);
    expect(status.value).toMatchObject({
      mode: "extension",
      extensionConnected: true,
      daemonVersion: "1.0.0",
    });
    expect((await c.next((m) => m.id === 4)).value).toBe(true);
    expect((await c.next((m) => m.id === 2)).value).toBe(77);
    expect((await c.next((m) => m.id === 3)).value).toEqual({ echoed: "Runtime.evaluate" });
    c.socket.destroy();
  });

  it("returns a typed failure for backend errors", async () => {
    daemon = await startInProcessDaemon();
    daemon.backend.sendCommand = async () => {
      const { BrowserUseError } = await import("@browser-use/protocol");
      throw new BrowserUseError("DIALOG_OPEN", "open", { hint: "handle it" });
    };
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    c.send({
      type: "sendCommand",
      id: 9,
      tabId: 1,
      method: "Runtime.evaluate",
      params: {},
      timeoutMs: 1000,
    });
    expect(await c.next((m) => m.type === "failure" && m.id === 9)).toMatchObject({
      error: { code: "DIALOG_OPEN", hint: "handle it" },
    });
    c.socket.destroy();
  });

  it("forwards subscribed CDP events and stops after unsubscribe", async () => {
    daemon = await startInProcessDaemon();
    const c = open(daemon.paths.ipcEndpoint);
    const subscriptionId = "11111111-1111-4111-8111-111111111111";
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    c.send({ type: "subscribe", subscriptionId, tabId: 3 });
    await c.next((m) => m.type === "helloAck");
    await new Promise((r) => setTimeout(r, 30));
    daemon.backend.emitEvent(3, "Page.loadEventFired", { timestamp: 1 });
    expect(await c.next((m) => m.type === "event")).toMatchObject({
      subscriptionId,
      method: "Page.loadEventFired",
    });
    c.send({ type: "unsubscribe", subscriptionId });
    await new Promise((r) => setTimeout(r, 30));
    const before = c.lines.length;
    daemon.backend.emitEvent(3, "Page.loadEventFired", {});
    await new Promise((r) => setTimeout(r, 30));
    expect(c.lines.length).toBe(before);
    c.socket.destroy();
  });

  it("creates pairing codes, rotates the token, and shuts down on request", async () => {
    daemon = await startInProcessDaemon();
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    c.send({ type: "createPairingCode", id: 1 });
    c.send({ type: "resetToken", id: 2 });
    c.send({ type: "shutdown", id: 3 });
    const pair = await c.next((m) => m.id === 1);
    expect((pair.value as { code: string }).code).toMatch(/^[A-Z2-9]{8}$/);
    await c.next((m) => m.id === 2);
    await c.next((m) => m.id === 3);
    expect(daemon.rotations).toBe(1);
    expect(daemon.shutdowns).toBe(1);
    c.socket.destroy();
  });

  it("drops a client that sends an oversized line", async () => {
    daemon = await startInProcessDaemon();
    const c = open(daemon.paths.ipcEndpoint);
    c.send({ type: "hello", protocolVersion: 1, clientVersion: "1" });
    await c.next((m) => m.type === "helloAck");
    c.socket.write("x".repeat(9 * 1024 * 1024));
    await new Promise((resolve) => c.socket.once("close", resolve));
  });
});
