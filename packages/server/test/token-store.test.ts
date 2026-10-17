import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../src/config";
import {
  FailureLimiter,
  loadOrCreateToken,
  PairingCodes,
  resetToken,
  tokensEqual,
} from "../src/daemon/token-store";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bu-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("token file", () => {
  it("creates a 64-hex token once and reuses it", async () => {
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    const first = await loadOrCreateToken(paths);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateToken(paths)).toBe(first);
  });

  it.skipIf(process.platform === "win32")("writes the token file with mode 0600", async () => {
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    await loadOrCreateToken(paths);
    expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("replaces a malformed token file", async () => {
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    await writeFile(paths.tokenFile, "garbage");
    expect(await loadOrCreateToken(paths)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resetToken rotates the token", async () => {
    const paths = resolvePaths({ BROWSER_USE_HOME: home });
    const first = await loadOrCreateToken(paths);
    const second = await resetToken(paths);
    expect(second).not.toBe(first);
    expect(await loadOrCreateToken(paths)).toBe(second);
  });
});

describe("tokensEqual", () => {
  it("compares equal-length strings and rejects different lengths", () => {
    expect(tokensEqual("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(tokensEqual("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(tokensEqual("a", "aa")).toBe(false);
  });
});

describe("PairingCodes", () => {
  it("issues 8-char codes that are single-use", () => {
    const codes = new PairingCodes();
    const code = codes.create();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(codes.consume(code)).toBe(true);
    expect(codes.consume(code)).toBe(false);
  });

  it("accepts dashes, spaces and lowercase", () => {
    const codes = new PairingCodes();
    const code = codes.create();
    expect(codes.consume(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase())).toBe(true);
  });

  it("expires after the TTL", () => {
    let now = 1_000;
    const codes = new PairingCodes(() => now, 300_000);
    const code = codes.create();
    now += 300_001;
    expect(codes.consume(code)).toBe(false);
  });

  it("rejects unknown codes", () => {
    expect(new PairingCodes().consume("ZZZZZZZZ")).toBe(false);
  });
});

describe("FailureLimiter", () => {
  it("blocks after max failures inside the window and recovers", () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 1_000, () => now);
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.blocked()).toBe(false);
      limiter.record();
    }
    expect(limiter.blocked()).toBe(true);
    now += 1_001;
    expect(limiter.blocked()).toBe(false);
  });
});
