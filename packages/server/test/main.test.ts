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

  it("prints usage for --help, -h and no arguments", async () => {
    const cases: string[][] = [["--help"], ["-h"], []];
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
});
