import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "../client/daemon-client";
import { type Paths, pointerEnabled } from "../config";
import { createToolContext } from "./create-context";
import { createMcpServer } from "./server";

export async function startMcpServer(options: {
  paths: Paths;
  entryScript: string;
  clientVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const client = await DaemonClient.connect({
    paths: options.paths,
    clientVersion: options.clientVersion,
    entryScript: options.entryScript,
  });
  const server = createMcpServer(
    createToolContext(client, { pointer: pointerEnabled(options.env) }),
  );
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    client.close();
    void server.close();
  };
  transport.onclose = shutdown;
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}
