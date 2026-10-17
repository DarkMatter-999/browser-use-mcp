import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Paths } from "../config";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function writeToken(paths: Paths, token: string): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  // chmod is a no-op for ACLs on Windows; the file lives in the user's private profile directory.
  await chmod(paths.tokenFile, 0o600).catch(() => undefined);
}

export async function loadOrCreateToken(paths: Paths): Promise<string> {
  try {
    const existing = (await readFile(paths.tokenFile, "utf8")).trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resetToken(paths);
}

export async function resetToken(paths: Paths): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeToken(paths, token);
  return token;
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class PairingCodes {
  readonly #codes = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  create(): string {
    let code = "";
    for (let index = 0; index < 8; index += 1)
      code += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
    this.#codes.set(code, this.now() + this.ttlMs);
    return code;
  }

  consume(input: string): boolean {
    const code = input.replace(/[-\s]/g, "").toUpperCase();
    const expiresAt = this.#codes.get(code);
    this.#codes.delete(code);
    return expiresAt !== undefined && expiresAt >= this.now();
  }
}

export class FailureLimiter {
  #failures: number[] = [];

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(): boolean {
    this.#prune();
    return this.#failures.length >= this.max;
  }

  record(): void {
    this.#failures.push(this.now());
  }

  #prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.#failures = this.#failures.filter((time) => time > cutoff);
  }
}
