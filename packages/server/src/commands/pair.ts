import type { CommandContext } from "./context";

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function runPair(ctx: CommandContext, args: string[]): Promise<number> {
  const reset = args.includes("--reset");
  const unknown = args.find((arg) => arg !== "--reset");
  if (unknown !== undefined) {
    ctx.io.err(`Unknown argument: ${unknown}\n`);
    return 2;
  }
  const client = await ctx.connect({
    paths: ctx.paths,
    clientVersion: ctx.clientVersion,
    entryScript: ctx.entryScript,
    autostart: true,
  });
  try {
    if (reset) {
      await client.resetToken();
      ctx.io.out("Token rotated: previously paired browsers must pair again.\n");
    }
    const { code, expiresInSeconds } = await client.createPairingCode();
    const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
    ctx.io.out(
      `Enter this code in the Browser Use extension popup: ${formatPairingCode(code)}\n` +
        `The code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.\n`,
    );
    return 0;
  } finally {
    client.close();
  }
}
