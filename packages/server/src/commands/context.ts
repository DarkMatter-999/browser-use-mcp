import type { DaemonClient } from "../client/daemon-client";
import type { Paths } from "../config";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface CommandContext {
  io: Io;
  paths: Paths;
  env: NodeJS.ProcessEnv;
  entryScript: string;
  clientVersion: string;
  connect: typeof DaemonClient.connect;
}

export async function connectExisting(ctx: CommandContext): Promise<DaemonClient | undefined> {
  try {
    return await ctx.connect({
      paths: ctx.paths,
      clientVersion: ctx.clientVersion,
      entryScript: ctx.entryScript,
      autostart: false,
    });
  } catch {
    return undefined;
  }
}
