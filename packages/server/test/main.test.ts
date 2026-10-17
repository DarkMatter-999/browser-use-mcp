import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run } from "../src/main";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe("run", () => {
  it("prints the package version for --version", () => {
    const { io, out } = capture();
    expect(run(["--version"], io)).toBe(0);
    expect(out.join("")).toBe(`${pkg.version}\n`);
  });

  it("prints usage for --help and for no arguments", () => {
    for (const argv of [["--help"], []]) {
      const { io, out } = capture();
      expect(run(argv, io)).toBe(0);
      expect(out.join("")).toContain("Usage: browser-use-mcp");
    }
  });

  it("rejects unknown arguments with exit code 2", () => {
    const { io, out, err } = capture();
    expect(run(["--bogus"], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("Unknown argument: --bogus");
    expect(err.join("")).toContain("--help");
  });
});
