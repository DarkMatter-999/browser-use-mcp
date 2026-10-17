import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run } from "../src/main";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe("run", () => {
  it("prints the package version for --version", async () => {
    const { io, out } = capture();
    expect(await run(["--version"], io)).toBe(0);
    expect(out.join("")).toBe(`${pkg.version}\n`);
  });

  it("prints usage for --help and -h", async () => {
    const cases: string[][] = [["--help"], ["-h"]];
    for (const argv of cases) {
      const { io, out } = capture();
      expect(await run(argv, io)).toBe(0);
      expect(out.join("")).toContain("Usage: browseruse-mcp");
    }
  });

  it("prints the version for -v", async () => {
    const { io, out } = capture();
    expect(await run(["-v"], io)).toBe(0);
    expect(out.join("")).toBe(`${pkg.version}\n`);
  });

  it("rejects unknown commands with exit code 2", async () => {
    const { io, err } = capture();
    expect(await run(["bogus"], io)).toBe(2);
    expect(err.join("")).toContain("Unknown command: bogus");
  });

  it("rejects unknown arguments with exit code 2", async () => {
    const { io, out, err } = capture();
    expect(await run(["--bogus"], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("Unknown argument: --bogus");
    expect(err.join("")).toContain("--help");
  });

  it("starts the MCP server when run with no arguments", async () => {
    const { io, out } = capture();
    let started = 0;
    const startMcp = (): Promise<void> => {
      started += 1;
      return Promise.resolve();
    };
    expect(await run([], io, { startMcp })).toBe(0);
    expect(started).toBe(1);
    expect(out).toEqual([]);
  });

  it("reports a startup failure on stderr with exit code 1", async () => {
    const { io, err } = capture();
    const { BrowserUseError } = await import("@browser-use/protocol");
    const startMcp = (): Promise<void> =>
      Promise.reject(new BrowserUseError("INTERNAL", "no daemon", { hint: "run doctor" }));
    expect(await run([], io, { startMcp })).toBe(1);
    expect(err.join("")).toContain("browseruse-mcp failed: no daemon (run doctor)");
  });
});
