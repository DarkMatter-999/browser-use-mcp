import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BrowserUseError } from "@browser-use/protocol";

interface ProfileDirectoryInfo {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}

export interface ProfileDirectoryFilesystem {
  lstat(path: string): Promise<ProfileDirectoryInfo>;
  mkdir(path: string, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const defaultFilesystem: ProfileDirectoryFilesystem = { lstat, mkdir, chmod };

function invalidProfile(path: string, message: string): BrowserUseError {
  return new BrowserUseError("INVALID_ARGUMENT", `Unsafe browser profile at ${path}: ${message}`, {
    hint: "Choose a real directory dedicated to Browser Use; do not point it at a symlink or file.",
  });
}

export async function prepareProfileDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  filesystem: ProfileDirectoryFilesystem = defaultFilesystem,
): Promise<void> {
  const parent = await filesystem.lstat(dirname(path));
  if (parent.isSymbolicLink()) throw invalidProfile(path, "the parent path is a symbolic link");
  if (!parent.isDirectory()) throw invalidProfile(path, "the parent path is not a directory");
  const uid = platform === "win32" ? undefined : process.getuid?.();
  if (uid !== undefined && parent.uid !== uid) {
    throw new BrowserUseError(
      "INTERNAL",
      `Browser profile parent for ${path} is owned by another user`,
      {
        hint: "Use a profile directory under a Browser Use home directory you own.",
      },
    );
  }

  let info: ProfileDirectoryInfo | undefined;
  try {
    info = await filesystem.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await filesystem.mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    info = await filesystem.lstat(path);
  }

  if (info.isSymbolicLink()) throw invalidProfile(path, "the path is a symbolic link");
  if (!info.isDirectory()) throw invalidProfile(path, "the path is not a directory");

  if (platform !== "win32") {
    if (uid !== undefined && info.uid !== uid) {
      throw new BrowserUseError("INTERNAL", `Browser profile ${path} is owned by another user`, {
        hint: "Use a profile directory you own, or remove the unsafe path before restarting Browser Use.",
      });
    }
    if ((info.mode & 0o777) !== 0o700) await filesystem.chmod(path, 0o700);
  }
}
