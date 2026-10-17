import { BrowserUseError, type WireMessage } from "@browser-use/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type BridgeState } from "../src/bridge/client";
import { Settings } from "../src/bridge/settings";
import { FakeWebSocket, MemoryStore, socketAt } from "./helpers/fakes";

const TOKEN = "a".repeat(64);
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(initial: Record<string, unknown> = { token: TOKEN, port: 40000 }) {
  FakeWebSocket.instances = [];
  const store = new MemoryStore(initial);
  const states: BridgeState[] = [];
  const messages: WireMessage[] = [];
  const client = new BridgeClient(
    {
      settings: new Settings(store),
      createSocket: (url) => new FakeWebSocket(url),
      extensionVersion: "0.0.0",
    },
    { onMessage: (message) => messages.push(message), onState: (state) => states.push(state) },
  );
  return { client, store, states, messages };
}

async function ready(ctx = setup()) {
  await ctx.client.start();
  await flush();
  const socket = socketAt(0);
  socket.open();
  socket.receive({ type: "helloAck", version: 1, daemonVersion: "1.0.0" });
  await flush();
  return { ...ctx, socket };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BridgeClient connect", () => {
  it("stays unpaired and opens no socket without a token", async () => {
    const { client, states } = setup({});
    await client.start();
    expect(states).toEqual(["unpaired"]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("connects to the configured port, says hello with the token, and becomes ready on helloAck", async () => {
    const { client, socket, states } = await ready();
    expect(socket.url).toBe("ws://127.0.0.1:40000");
    expect(socket.messages()[0]).toMatchObject({
      type: "hello",
      version: 1,
      token: TOKEN,
      extensionVersion: "0.0.0",
    });
    expect(client.state).toBe("ready");
    expect(states).toEqual(["connecting", "ready"]);
  });

  it("defaults the port to 38241 and keeps a stable peerId across reconnects", async () => {
    const { socket, store } = await ready(setup({ token: TOKEN }));
    expect(socket.url).toBe("ws://127.0.0.1:38241");
    const first = (socket.messages()[0] as { peerId: string }).peerId;
    expect(store.data.peerId).toBe(first);
  });

  it("routes non-handshake messages to the handler", async () => {
    const { socket, messages } = await ready();
    socket.receive({
      type: "fileAccess",
      version: 1,
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "fileAccess" });
  });

  it("closes the socket on an invalid message", async () => {
    const { socket } = await ready();
    socket.onmessage?.({ data: "{nope" });
    expect(socket.closeCode).toBe(1002);
  });
});

describe("heartbeat and reconnect", () => {
  it("pings every 20 seconds and tolerates a pong", async () => {
    const { socket } = await ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.messages().at(-1)).toMatchObject({ type: "ping" });
    socket.receive({ type: "pong", version: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.closeCode).toBeUndefined();
  });

  it("closes and reconnects when a ping gets no pong", async () => {
    const { socket, client } = await ready();
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(socket.closeCode).toBe(4000);
    expect(client.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off 1s, 2s, 4s and resets after a successful handshake", async () => {
    const { client } = setup();
    await client.start();
    await flush();
    socketAt(0).close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    socketAt(1).close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    const third = socketAt(2);
    third.open();
    third.receive({ type: "helloAck", version: 1, daemonVersion: "1" });
    await flush();
    third.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("caps the backoff at 30 seconds", async () => {
    const { client } = setup();
    await client.start();
    await flush();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      socketAt(-1).close();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const before = FakeWebSocket.instances.length;
    socketAt(-1).close();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeWebSocket.instances).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });
});

describe("authentication failures", () => {
  it("clears the token and stops reconnecting on NOT_PAIRED", async () => {
    const { client, socket, store } = await ready();
    socket.receive({
      type: "error",
      version: 1,
      error: { code: "NOT_PAIRED", message: "Not paired" },
    });
    await flush();
    socket.close(1008);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.data.token).toBeUndefined();
    expect(client.state).toBe("unpaired");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports VERSION_MISMATCH and waits 30 seconds before retrying", async () => {
    const { client, states } = setup();
    await client.start();
    await flush();
    const first = socketAt(0);
    first.open();
    first.receive({
      type: "error",
      version: 1,
      error: { code: "VERSION_MISMATCH", message: "update", hint: "same release" },
    });
    await flush();
    first.close(1002);
    expect(states).toContain("error");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("pair", () => {
  it("exchanges a normalised code for a token, stores it and connects", async () => {
    const { client, store } = setup({});
    await client.start();
    const paired = client.pair("abcd-2345");
    await flush();
    const pairing = socketAt(0);
    pairing.open();
    expect(pairing.messages()[0]).toMatchObject({ type: "pair", version: 1, code: "ABCD2345" });
    pairing.receive({ type: "paired", version: 1, token: TOKEN });
    await paired;
    expect(store.data.token).toBe(TOKEN);
    await flush();
    const main = socketAt(-1);
    main.open();
    expect(main.messages()[0]).toMatchObject({ type: "hello", token: TOKEN });
  });

  it("rejects with NOT_PAIRED when the code is refused and stores nothing", async () => {
    const { client, store } = setup({});
    await client.start();
    const paired = client.pair("ZZZZZZZZ");
    const assertion = expect(paired).rejects.toMatchObject({ code: "NOT_PAIRED" });
    await flush();
    const pairing = socketAt(0);
    pairing.open();
    pairing.receive({
      type: "error",
      version: 1,
      error: { code: "NOT_PAIRED", message: "Invalid or expired pairing code." },
    });
    await assertion;
    expect(store.data.token).toBeUndefined();
  });

  it("rejects with TIMEOUT when the daemon never answers", async () => {
    const { client } = setup({});
    await client.start();
    const paired = client.pair("ABCD2345");
    const assertion = expect(paired).rejects.toMatchObject({ code: "TIMEOUT" });
    await flush();
    socketAt(0).open();
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("rejects a malformed code locally with INVALID_ARGUMENT", async () => {
    const { client } = setup({});
    await expect(client.pair("short")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("send", () => {
  it("throws BRIDGE_DISCONNECTED when not ready", () => {
    const { client } = setup();
    expect(() => {
      client.send({ type: "ping", version: 1 });
    }).toThrow(BrowserUseError);
  });

  it("serialises when ready and rejects over the 2 MiB limit", async () => {
    const { client, socket } = await ready();
    client.send({ type: "ping", version: 1 });
    expect(socket.messages().at(-1)).toMatchObject({ type: "ping" });
    expect(() => {
      client.send({
        type: "response",
        version: 1,
        requestId: "11111111-1111-4111-8111-111111111111",
        result: "x".repeat(2 * 1024 * 1024),
      });
    }).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });
});
