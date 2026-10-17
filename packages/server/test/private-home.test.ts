import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateHome } from "../src/daemon/private-home";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "bu-home-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("ensurePrivateHome", () => {
  it("creates a missing home with mode 0700", async () => {
    const home = join(base, "nested", "home");
    await ensurePrivateHome(home);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("tightens an existing permissive home to 0700", async () => {
    await chmod(base, 0o755);
    await ensurePrivateHome(base);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a home owned by another user", async () => {
    // `/` is owned by root, so for any non-root user it is someone else's directory.
    await expect(ensurePrivateHome("/")).rejects.toThrow(/owned by another user/);
  });
});
