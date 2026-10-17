import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BridgeServer } from "../src/daemon/bridge-server";
import { FailureLimiter, PairingCodes } from "../src/daemon/token-store";

const TOKEN = "e".repeat(64);
const EXT = "abcdefghijklmnopabcdefghijklmnop";
const servers: BridgeServer[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function start(lines?: string[]) {
  const port = await freePort();
  const codes = new PairingCodes();
  const server = new BridgeServer({
    port,
    extensionId: EXT,
    daemonVersion: "1.2.3",
    auth: {
      verifyToken: (token) => token === TOKEN,
      consumePairingCode: (code) => (codes.consume(code) ? TOKEN : undefined),
      limiter: new FailureLimiter(),
    },
    ...(lines === undefined
      ? {}
      : {
          log: {
            info: (line: string) => {
              lines.push(line);
              return Promise.resolve();
            },
            error: (line: string) => {
              lines.push(line);
              return Promise.resolve();
            },
          },
        }),
  });
  await server.start();
  servers.push(server);
  return { server, port, codes };
}

function connect(
  port: number,
  origin = `chrome-extension://${EXT}`,
  headers: Record<string, string> = {},
) {
  return new WebSocket(`ws://127.0.0.1:${port}`, { origin, headers });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    socket.once("message", (data) => {
      resolve(JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<string, unknown>);
    }),
  );
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`HTTP ${response.statusCode}`));
    });
  });
}

const helloMessage = () => ({
  type: "hello",
  version: 1,
  peerId: randomUUID(),
  token: TOKEN,
  extensionVersion: "0",
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("BridgeServer", () => {
  it("accepts the pinned origin and completes a token handshake", async () => {
    const { server, port } = await start();
    const socket = connect(port);
    await opened(socket);
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(helloMessage()));
    expect(await ack).toMatchObject({ type: "helloAck", daemonVersion: "1.2.3" });
    expect(server.peer?.isReady).toBe(true);
    socket.close();
  });

  it("rejects a foreign origin and a missing origin before upgrade", async () => {
    const { port } = await start();
    await expect(
      opened(connect(port, "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")),
    ).rejects.toThrow(/401|403|Unexpected/);
    await expect(opened(connect(port, "https://evil.example"))).rejects.toThrow(
      /401|403|Unexpected/,
    );
  });

  it("rejects a wrong Host header (DNS rebinding)", async () => {
    const { port } = await start();
    await expect(
      opened(connect(port, undefined, { Host: `evil.example:${port}` })),
    ).rejects.toThrow(/401|403|Unexpected/);
  });

  it("denies a wrong token and never exposes a ready peer", async () => {
    const { server, port } = await start();
    const socket = connect(port);
    await opened(socket);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ ...helloMessage(), token: "f".repeat(64) }));
    expect(await reply).toMatchObject({ error: { code: "NOT_PAIRED" } });
    expect(server.peer).toBeUndefined();
  });

  it("logs rejected upgrades and handshake denials, never the token", async () => {
    const lines: string[] = [];
    const { port } = await start(lines);
    await expect(opened(connect(port, "https://evil.example"))).rejects.toThrow();
    await expect(
      opened(connect(port, undefined, { Host: `evil.example:${port}` })),
    ).rejects.toThrow();
    const socket = connect(port);
    await opened(socket);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ ...helloMessage(), token: "f".repeat(64) }));
    await reply;
    expect(lines[0]).toMatch(/upgrade rejected .*origin "https:\/\/evil\.example"/);
    expect(lines[1]).toMatch(/upgrade rejected .*host "evil\.example:\d+"/);
    expect(lines[2]).toMatch(/bridge peer :\d+: handshake denied \(NOT_PAIRED\)/);
    expect(lines.join("\n")).not.toContain("f".repeat(64));
  });

  it("pairs with a code, then hello succeeds", async () => {
    const { server, port, codes } = await start();
    const socket = connect(port);
    await opened(socket);
    const paired = nextMessage(socket);
    socket.send(JSON.stringify({ type: "pair", version: 1, code: codes.create() }));
    expect(await paired).toEqual({ type: "paired", version: 1, token: TOKEN });
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(helloMessage()));
    expect(await ack).toMatchObject({ type: "helloAck" });
    expect(server.peer?.isReady).toBe(true);
    socket.close();
  });

  it("replaces the previous ready peer when a new authenticated one connects", async () => {
    const { server, port } = await start();
    const first = connect(port);
    await opened(first);
    first.send(JSON.stringify(helloMessage()));
    await nextMessage(first);
    const closed = new Promise<number>((resolve) =>
      first.once("close", (code) => {
        resolve(code);
      }),
    );
    const second = connect(port);
    await opened(second);
    second.send(JSON.stringify(helloMessage()));
    await nextMessage(second);
    expect(await closed).toBe(1001);
    expect(server.peer?.isReady).toBe(true);
    second.close();
  });

  it("an unauthenticated connection does not evict a ready peer", async () => {
    const { server, port } = await start();
    const good = connect(port);
    await opened(good);
    good.send(JSON.stringify(helloMessage()));
    await nextMessage(good);
    const intruder = connect(port);
    await opened(intruder);
    intruder.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.peer?.isReady).toBe(true);
    good.close();
  });

  it("requirePeer throws BRIDGE_DISCONNECTED with a hint when nothing is connected", async () => {
    const { server } = await start();
    expect(() => server.requirePeer()).toThrow(
      expect.objectContaining({ code: "BRIDGE_DISCONNECTED" }),
    );
  });

  it("reports a busy port with an actionable error and never kills the owner", async () => {
    const { port } = await start();
    const second = new BridgeServer({
      port,
      extensionId: EXT,
      daemonVersion: "1",
      auth: {
        verifyToken: () => false,
        consumePairingCode: () => undefined,
        limiter: new FailureLimiter(),
      },
    });
    await expect(second.start()).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining(String(port)) as string,
    });
  });
});
