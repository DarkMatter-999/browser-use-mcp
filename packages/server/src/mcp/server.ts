import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../../package.json" with { type: "json" };
import { allTools } from "../tools";
import type { ToolContext } from "./context";
import type { AnyTool } from "./define-tool";

export function createMcpServer(ctx: ToolContext, tools: readonly AnyTool[] = allTools): McpServer {
  const server = new McpServer({ name: "browser-use", version: pkg.version });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      async (args) => ({ ...(await tool.run(ctx, args)) }),
    );
  }
  return server;
}
