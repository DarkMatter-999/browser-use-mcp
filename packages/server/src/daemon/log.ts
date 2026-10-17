import { appendFile, chmod, rename, stat } from "node:fs/promises";

export interface Logger {
  info(message: string): Promise<void>;
  error(message: string): Promise<void>;
}

export function createLogger(file: string, options: { maxBytes?: number } = {}): Logger {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  let tightened = false;
  async function write(level: string, message: string): Promise<void> {
    try {
      if (!tightened) {
        // A log created by an older version may be world-readable; new files are created 0600.
        tightened = true;
        await chmod(file, 0o600).catch(() => undefined);
      }
      const size = await stat(file).then(
        (info) => info.size,
        () => 0,
      );
      if (size > maxBytes) await rename(file, `${file}.1`);
      await appendFile(file, `${new Date().toISOString()} ${level} ${message}\n`, {
        mode: 0o600,
      });
    } catch {
      /* logging must never take the daemon down */
    }
  }
  return { info: (message) => write("INFO", message), error: (message) => write("ERROR", message) };
}
