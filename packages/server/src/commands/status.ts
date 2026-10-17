import { type CommandContext, connectExisting } from "./context";

export async function runStatus(ctx: CommandContext, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    ctx.io.err(`Unknown argument: ${unknown}\n`);
    return 2;
  }
  const client = await connectExisting(ctx);
  if (!client) {
    ctx.io.out(json ? `${JSON.stringify({ running: false })}\n` : "Daemon: not running\n");
    return 0;
  }
  try {
    const status = await client.status();
    if (json) {
      ctx.io.out(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `Daemon: running (v${status.daemonVersion}, pid ${status.pid})`,
      `Extension: ${
        status.extensionConnected
          ? "connected"
          : 'not connected (it connects while a tab is connected, or always with "Let the agent open tabs" on)'
      }`,
      `Tabs: ${status.tabs.length}`,
      ...status.tabs.map((tab) => `  ${tab.tabId}  ${tab.title}  ${tab.url}`),
    ];
    ctx.io.out(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    client.close();
  }
}
