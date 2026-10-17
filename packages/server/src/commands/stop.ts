import { type CommandContext, connectExisting } from "./context";

export async function runStop(ctx: CommandContext): Promise<number> {
  const client = await connectExisting(ctx);
  if (!client) {
    ctx.io.out("Daemon was not running.\n");
    return 0;
  }
  try {
    await client.shutdown();
  } finally {
    client.close();
  }
  ctx.io.out("Daemon stopped.\n");
  return 0;
}
