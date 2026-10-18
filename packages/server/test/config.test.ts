import { EXTENSION_ID } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_PORT,
  pointerEnabled,
  resolveBrowserConfig,
  resolveExtensionId,
  resolvePaths,
  resolvePort,
  resolveProfileDir,
} from "../src/config";

describe("resolvePaths", () => {
  it("uses BROWSER_USE_HOME and a unix socket on linux/macOS", () => {
    const paths = resolvePaths({ BROWSER_USE_HOME: "/tmp/bu-x" }, "linux");
    expect(paths.home).toBe("/tmp/bu-x");
    expect(paths.tokenFile).toBe("/tmp/bu-x/token");
    expect(paths.ipcEndpoint).toBe("/tmp/bu-x/daemon.sock");
  });

  it("uses a named pipe on win32, stable per home directory", () => {
    const a = resolvePaths({ BROWSER_USE_HOME: "C:\\bu-a" }, "win32");
    const b = resolvePaths({ BROWSER_USE_HOME: "C:\\bu-b" }, "win32");
    expect(a.ipcEndpoint).toMatch(/^\\\\\.\\pipe\\browser-use-[0-9a-f]{16}$/);
    expect(a.ipcEndpoint).not.toBe(b.ipcEndpoint);
    expect(resolvePaths({ BROWSER_USE_HOME: "C:\\bu-a" }, "win32").ipcEndpoint).toBe(a.ipcEndpoint);
  });
});

describe("resolvePort", () => {
  it("defaults, parses and validates", () => {
    expect(resolvePort({})).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolvePort({ BROWSER_USE_PORT: "40000" })).toBe(40000);
    expect(() => resolvePort({ BROWSER_USE_PORT: "0" })).toThrow(/between 1 and 65535/);
    expect(() => resolvePort({ BROWSER_USE_PORT: "abc" })).toThrow(/between 1 and 65535/);
  });
});

describe("misc settings", () => {
  it("defaults to the pinned extension id and allows a dev override", () => {
    expect(resolveExtensionId({})).toBe(EXTENSION_ID);
    expect(resolveExtensionId({ BROWSER_USE_EXTENSION_ID: "x" })).toBe("x");
  });
  it("enables the pointer unless BROWSER_USE_POINTER=0", () => {
    expect(pointerEnabled({})).toBe(true);
    expect(pointerEnabled({ BROWSER_USE_POINTER: "0" })).toBe(false);
  });
});

describe("resolveBrowserConfig", () => {
  it("defaults to extension mode and the dedicated persistent profile", () => {
    const config = resolveBrowserConfig({});
    expect(config).toEqual({ mode: "extension", profile: "default" });
    expect(
      resolveProfileDir(resolvePaths({ BROWSER_USE_HOME: "/tmp/bu-home" }), "default", "linux"),
    ).toBe("/tmp/bu-home/profile");
  });

  it("accepts every supported mode and profile", () => {
    expect(
      resolveBrowserConfig({ BROWSER_USE_MODE: "headless", BROWSER_USE_PROFILE: "guest" }),
    ).toEqual({ mode: "headless", profile: "guest" });
    expect(
      resolveBrowserConfig({ BROWSER_USE_MODE: "auto", BROWSER_USE_PROFILE: "default" }),
    ).toEqual({ mode: "auto", profile: "default" });
    expect(
      resolveBrowserConfig({ BROWSER_USE_MODE: "extension", BROWSER_USE_PROFILE: "guest" }),
    ).toEqual({ mode: "extension", profile: "guest" });
  });

  it("treats empty settings as defaults and exposes an explicit executable override", () => {
    expect(
      resolveBrowserConfig({
        BROWSER_USE_MODE: "",
        BROWSER_USE_PROFILE: "",
        BROWSER_USE_CHROME_PATH: "/usr/bin/chromium",
      }),
    ).toEqual({
      mode: "extension",
      profile: "default",
      executablePath: "/usr/bin/chromium",
    });
  });

  it("normalizes a relative browser executable path against the MCP process cwd", () => {
    expect(
      resolveBrowserConfig({ BROWSER_USE_CHROME_PATH: "./bin/chromium" }, "linux", "/work/mcp"),
    ).toEqual({
      mode: "extension",
      profile: "default",
      executablePath: "/work/mcp/bin/chromium",
    });
  });

  it("rejects unsupported modes and profiles", () => {
    expect(() => resolveBrowserConfig({ BROWSER_USE_MODE: "auto-ish" })).toThrow(
      /BROWSER_USE_MODE/,
    );
    expect(() => resolveBrowserConfig({ BROWSER_USE_PROFILE: "private" })).toThrow(
      /BROWSER_USE_PROFILE/,
    );
  });
});

describe("resolveProfileDir", () => {
  it("keeps the guest profile separate from persistent state", () => {
    expect(
      resolveProfileDir(resolvePaths({ BROWSER_USE_HOME: "/tmp/bu-home" }), "guest", "linux"),
    ).toBeUndefined();
  });

  it("uses the target platform's path rules for the dedicated profile", () => {
    expect(
      resolveProfileDir(
        resolvePaths({ BROWSER_USE_HOME: "C:\\bu-home" }, "win32"),
        "default",
        "win32",
      ),
    ).toBe("C:\\bu-home\\profile");
  });
});
