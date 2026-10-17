import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/daemon/log";

describe("createLogger", () => {
  it("appends timestamped lines and rotates past the size limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bu-"));
    try {
      const file = join(dir, "daemon.log");
      const log = createLogger(file, { maxBytes: 200 });
      await log.info("first");
      expect(await readFile(file, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T.* INFO first\n$/);
      await writeFile(file, "x".repeat(300));
      await log.error("after rotation");
      expect((await stat(`${file}.1`)).size).toBe(300);
      expect(await readFile(file, "utf8")).toContain("ERROR after rotation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
