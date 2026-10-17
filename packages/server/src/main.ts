import pkg from "../package.json" with { type: "json" };

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const HELP = `browser-use-mcp ${pkg.version}

Usage: browser-use-mcp [options]

Options:
  --version  Print the version
  --help     Print this help
`;

export function run(argv: string[], io: Io): number {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`${pkg.version}\n`);
    return 0;
  }
  io.err(`Unknown argument: ${first}\nRun browser-use-mcp --help for usage.\n`);
  return 2;
}
