import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareProfileDirectory,
  type ProfileDirectoryFilesystem,
} from "../src/daemon/profile-directory";

describe("prepareProfileDirectory", () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("creates and restricts a new persistent profile directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-profile-"));
    homes.push(home);
    const profile = join(home, "profile");

    await prepareProfileDirectory(profile, "linux");

    expect((await lstat(profile)).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink instead of chmodding or launching through its target", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-profile-link-"));
    homes.push(home);
    const target = join(home, "target");
    const profile = join(home, "profile");
    await mkdir(target);
    await symlink(target, profile);

    await expect(prepareProfileDirectory(profile, "linux")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      hint: expect.stringMatching(/real directory/i) as string,
    });
    expect((await lstat(target)).mode & 0o777).not.toBe(0o700);
  });

  it("rejects a symlinked parent instead of creating the profile outside Browser Use home", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-profile-parent-link-"));
    homes.push(home);
    const target = join(home, "target");
    const linkedHome = join(home, "linked-home");
    await mkdir(target);
    await symlink(target, linkedHome);

    await expect(
      prepareProfileDirectory(join(linkedHome, "profile"), "linux"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      hint: expect.stringMatching(/symlink/i) as string,
    });
    expect(existsSync(join(target, "profile"))).toBe(false);
  });

  it("rejects a regular file at the profile path", async () => {
    const home = await mkdtemp(join(tmpdir(), "bu-profile-file-"));
    homes.push(home);
    const profile = join(home, "profile");
    await writeFile(profile, "not a profile directory");

    await expect(prepareProfileDirectory(profile, "linux")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(/not a directory/i) as string,
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects an existing profile owned by another user",
    async () => {
      const uid = process.getuid?.();
      if (uid === undefined) return;
      const fakeFs: ProfileDirectoryFilesystem = {
        lstat: () =>
          Promise.resolve({
            isDirectory: () => true,
            isSymbolicLink: () => false,
            uid: uid + 1,
            mode: 0o40700,
          }),
        mkdir: () => Promise.resolve(),
        chmod: () => Promise.resolve(),
      };

      await expect(
        prepareProfileDirectory("/tmp/fake-profile", "linux", fakeFs),
      ).rejects.toMatchObject({
        code: "INTERNAL",
        hint: expect.stringMatching(/directory you own/i) as string,
      });
    },
  );
});
