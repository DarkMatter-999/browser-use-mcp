import { EXTENSION_ID } from "@browser-use/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_PORT,
  pointerEnabled,
  resolveExtensionId,
  resolvePaths,
  resolvePort,
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
