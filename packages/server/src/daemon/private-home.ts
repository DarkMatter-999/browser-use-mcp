import { chmod, mkdir, stat } from "node:fs/promises";
import { BrowserUseError } from "@browser-use/protocol";

/**
 * Creates the state directory with mode 0700, or tightens an existing one to 0700 (spec 4.3:
 * `mkdir({mode})` leaves an existing directory's mode alone). Refuses to use a directory owned
 * by another user, because whoever owns it can replace the token or the IPC socket.
 *
 * Windows has no POSIX modes or uids here; the directory relies on the profile's ACL there.
 */
export async function ensurePrivateHome(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (platform === "win32") return;
  const info = await stat(home);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new BrowserUseError("INTERNAL", `${home} is owned by another user (uid ${info.uid})`, {
      hint: "Point BROWSER_USE_HOME at a directory you own, or fix the owner of this one.",
    });
  }
  if ((info.mode & 0o777) !== 0o700) await chmod(home, 0o700);
}
