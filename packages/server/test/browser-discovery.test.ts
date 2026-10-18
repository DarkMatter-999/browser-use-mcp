import { describe, expect, it } from "vitest";
import { discoverBrowser } from "../src/daemon/browser-discovery";

describe("discoverBrowser", () => {
  it("uses the configured executable override before platform discovery", async () => {
    const result = await discoverBrowser(
      "linux",
      { BROWSER_USE_CHROME_PATH: "/opt/chrome/custom-browser" },
      { isExecutable: (path) => Promise.resolve(path === "/opt/chrome/custom-browser") },
    );

    expect(result).toEqual({
      executablePath: "/opt/chrome/custom-browser",
      browserName: "configured browser",
    });
  });

  it("finds a known local Chromium candidate without launching or installing it", async () => {
    const checked: string[] = [];
    const result = await discoverBrowser(
      "linux",
      {},
      {
        isExecutable: (path) => {
          checked.push(path);
          return Promise.resolve(path === "/usr/bin/chromium");
        },
      },
    );

    expect(result).toEqual({ executablePath: "/usr/bin/chromium", browserName: "Chromium" });
    expect(checked).toContain("/usr/bin/chromium");
  });

  it("reports an actionable error when no local browser is found", async () => {
    await expect(
      discoverBrowser("linux", {}, { isExecutable: () => Promise.resolve(false) }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/No supported browser found/i) as string,
      hint: expect.stringMatching(/install Chromium|BROWSER_USE_CHROME_PATH/i) as string,
    });
  });

  it("rejects a missing configured executable instead of silently discovering another", async () => {
    await expect(
      discoverBrowser(
        "linux",
        { BROWSER_USE_CHROME_PATH: "/missing/chrome" },
        { isExecutable: () => Promise.resolve(false) },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/configured browser/i) as string,
    });
  });
});
