import { appendFile, rename, stat } from "node:fs/promises";

export interface Logger {
  info(message: string): Promise<void>;
  error(message: string): Promise<void>;
}

export function createLogger(file: string, options: { maxBytes?: number } = {}): Logger {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  async function write(level: string, message: string): Promise<void> {
    try {
      const size = await stat(file).then(
        (info) => info.size,
        () => 0,
      );
      if (size > maxBytes) await rename(file, `${file}.1`);
      await appendFile(file, `${new Date().toISOString()} ${level} ${message}\n`);
    } catch {
      /* logging must never take the daemon down */
    }
  }
  return { info: (message) => write("INFO", message), error: (message) => write("ERROR", message) };
}
