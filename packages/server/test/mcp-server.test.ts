import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserUseError } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/mcp/define-tool";
import { imageResult, jsonResult } from "../src/mcp/format";
import { createMcpServer } from "../src/mcp/server";
import { makeContext } from "./helpers/context";

async function connect(tools: Parameters<typeof createMcpServer>[1]) {
  const server = createMcpServer(makeContext(), tools);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const echo = defineTool({
  name: "test_echo",
  title: "Echo",
  description: "Echo a value",
  inputShape: { value: z.string() },
  handler: (_ctx, args) => Promise.resolve(jsonResult({ echoed: args.value })),
});
const boom = defineTool({
  name: "test_boom",
  title: "Boom",
  description: "Always fails",
  inputShape: {},
  handler: () =>
    Promise.reject(
      new BrowserUseError("STALE_REF", "ref is stale", {
        hint: "take a new snapshot",
        details: { ref: "e3" },
      }),
    ),
});
const crash = defineTool({
  name: "test_crash",
  title: "Crash",
  description: "Throws a plain error",
  inputShape: {},
  handler: () => Promise.reject(new Error("kaput")),
});
const pic = defineTool({
  name: "test_pic",
  title: "Pic",
  description: "Returns an image",
  inputShape: {},
  handler: () => Promise.resolve(imageResult("AAAA", "image/png")),
});

const textOf = (result: Record<string, unknown>): string =>
  (result.content as { text: string }[] | undefined)?.[0]?.text ?? "";

describe("createMcpServer", () => {
  it("lists registered tools with their schemas", async () => {
    const client = await connect([echo, boom]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["test_echo", "test_boom"]);
    expect(tools[0]?.inputSchema.properties).toHaveProperty("value");
  });

  it("returns JSON text for successful calls", async () => {
    const client = await connect([echo]);
    const result = await client.callTool({ name: "test_echo", arguments: { value: "hi" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ echoed: "hi" });
  });

  it("maps BrowserUseError to an isError result that keeps code, hint and details", async () => {
    const client = await connect([boom]);
    const result = await client.callTool({ name: "test_boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      error: {
        code: "STALE_REF",
        message: "ref is stale",
        hint: "take a new snapshot",
        details: { ref: "e3" },
      },
    });
  });

  it("maps unexpected errors to INTERNAL", async () => {
    const client = await connect([crash]);
    const result = await client.callTool({ name: "test_crash", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      error: { code: "INTERNAL", message: "kaput" },
    });
  });

  it("passes image content through", async () => {
    const client = await connect([pic]);
    const result = await client.callTool({ name: "test_pic", arguments: {} });
    expect(result.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("rejects invalid arguments without calling the handler", async () => {
    const client = await connect([echo]);
    const outcome = await client.callTool({ name: "test_echo", arguments: { value: 5 } }).then(
      (result) => ({ isError: result.isError === true }),
      () => ({ isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });
});
