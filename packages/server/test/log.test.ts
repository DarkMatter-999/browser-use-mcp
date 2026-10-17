import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it.skipIf(process.platform === "win32")(
    "creates the log 0600 and tightens an existing world-readable one",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "bu-"));
      try {
        const fresh = join(dir, "fresh.log");
        await createLogger(fresh).info("x");
        expect((await stat(fresh)).mode & 0o777).toBe(0o600);
        const old = join(dir, "old.log");
        await writeFile(old, "old\n");
        await chmod(old, 0o644);
        await createLogger(old).info("y");
        expect((await stat(old)).mode & 0o777).toBe(0o600);
        const rotating = join(dir, "rotating.log");
        const log = createLogger(rotating, { maxBytes: 10 });
        await log.info("a long enough line");
        await log.info("after rotation");
        expect((await stat(rotating)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
