import pkg from "../package.json" with { type: "json" };
import { DaemonClient } from "./client/daemon-client";
import type { Io } from "./commands/context";
import { runDoctor } from "./commands/doctor";
import { runPair } from "./commands/pair";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { type Paths, resolvePaths } from "./config";

export type { Io };

export interface CliDeps {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  entryScript?: string;
  connect?: typeof DaemonClient.connect;
  runDaemon?: () => Promise<void>;
}

const HELP = `browseruse-mcp ${pkg.version}

Usage: browseruse-mcp <command> [options]

Commands:
  status [--json]  Show daemon, extension and tab status
  stop             Stop the background daemon
  pair [--reset]   Print a pairing code for the browser extension
  doctor           Diagnose common setup problems
  daemon           Run the background daemon in the foreground

Options:
  -v, --version  Print the version
  -h, --help     Print this help
`;

export async function run(argv: string[], io: Io, deps: CliDeps = {}): Promise<number> {
  const [first, ...rest] = argv;
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? resolvePaths(env);
  const connect = deps.connect ?? DaemonClient.connect.bind(DaemonClient);
  const entryScript = deps.entryScript ?? process.argv[1] ?? "";
  const ctx = { io, paths, env, entryScript, clientVersion: pkg.version, connect };
  switch (first) {
    case undefined:
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;
    case "--version":
    case "-v":
      io.out(`${pkg.version}\n`);
      return 0;
    case "status":
      return runStatus(ctx, rest);
    case "stop":
      return runStop(ctx);
    case "pair":
      return runPair(ctx, rest);
    case "doctor":
      return runDoctor(ctx);
    case "daemon": {
      const start = deps.runDaemon ?? (await import("./daemon/run-daemon")).runDaemon;
      await start();
      return 0;
    }
    default:
      io.err(
        first.startsWith("-") ? `Unknown argument: ${first}\n` : `Unknown command: ${first}\n`,
      );
      io.err("Run browseruse-mcp --help for usage.\n");
      return 2;
  }
}
