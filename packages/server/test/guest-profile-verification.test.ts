import { describe, expect, it } from "vitest";
import { isGuestProfilePath } from "../src/daemon/launch-backend";

describe("isGuestProfilePath", () => {
  it.each([
    ["/tmp/browser-profile/Guest Profile", true],
    ["/tmp/browser-profile/Guest Session", true],
    ["/tmp/browser-profile/Default", false],
    ["/tmp/browser-profile/Default/Profile 1", false],
    ["/tmp/another-profile/Guest Profile", false],
  ])("classifies a Chromium profile path %s", (profilePath, expected) => {
    expect(isGuestProfilePath(profilePath, "/tmp/browser-profile", "linux")).toBe(expected);
  });

  it("uses Windows path rules when validating a Windows browser profile", () => {
    expect(isGuestProfilePath("C:\\bu\\Guest Profile", "C:\\bu", "win32")).toBe(true);
    expect(isGuestProfilePath("C:\\elsewhere\\Guest Profile", "C:\\bu", "win32")).toBe(false);
  });
});
