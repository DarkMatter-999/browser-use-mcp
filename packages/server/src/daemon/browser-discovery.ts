import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import { BrowserUseError } from "@browser-use/protocol";

export interface DiscoveredBrowser {
  executablePath: string;
  browserName: string;
}

export interface BrowserDiscoveryDeps {
  isExecutable(path: string): Promise<boolean>;
}

const linuxCandidates: readonly DiscoveredBrowser[] = [
  { executablePath: "/usr/bin/google-chrome", browserName: "Google Chrome" },
  { executablePath: "/usr/bin/google-chrome-stable", browserName: "Google Chrome" },
  { executablePath: "/usr/bin/chromium", browserName: "Chromium" },
  { executablePath: "/usr/bin/chromium-browser", browserName: "Chromium" },
  { executablePath: "/usr/bin/microsoft-edge", browserName: "Microsoft Edge" },
  { executablePath: "/usr/bin/brave-browser", browserName: "Brave" },
];

const macCandidates: readonly DiscoveredBrowser[] = [
  {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    browserName: "Google Chrome",
  },
  {
    executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    browserName: "Chromium",
  },
  {
    executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    browserName: "Microsoft Edge",
  },
  {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    browserName: "Brave",
  },
];

function windowsCandidates(env: NodeJS.ProcessEnv): DiscoveredBrowser[] {
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  );
  const join = win32.join;
  const candidates: DiscoveredBrowser[] = [];
  for (const root of roots) {
    candidates.push(
      {
        executablePath: join(root, "Google", "Chrome", "Application", "chrome.exe"),
        browserName: "Google Chrome",
      },
      {
        executablePath: join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        browserName: "Microsoft Edge",
      },
      {
        executablePath: join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        browserName: "Brave",
      },
      {
        executablePath: join(root, "Chromium", "Application", "chrome.exe"),
        browserName: "Chromium",
      },
    );
  }
  return candidates;
}

function pathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DiscoveredBrowser[] {
  const windows = platform === "win32";
  const names: readonly (readonly [string, string])[] = windows
    ? [
        ["chrome.exe", "Google Chrome"],
        ["msedge.exe", "Microsoft Edge"],
        ["brave.exe", "Brave"],
        ["chromium.exe", "Chromium"],
      ]
    : [
        ["google-chrome", "Google Chrome"],
        ["google-chrome-stable", "Google Chrome"],
        ["chromium", "Chromium"],
        ["chromium-browser", "Chromium"],
        ["microsoft-edge", "Microsoft Edge"],
        ["brave-browser", "Brave"],
      ];
  const paths = (env.PATH ?? "").split(windows ? win32.delimiter : posix.delimiter).filter(Boolean);
  const join = windows ? win32.join : posix.join;
  return paths.flatMap((directory) =>
    names.map(([name, browserName]) => ({
      executablePath: join(directory, name),
      browserName,
    })),
  );
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  deps: BrowserDiscoveryDeps = {
    isExecutable: (path) => isExecutable(path, platform),
  },
): Promise<DiscoveredBrowser> {
  const override = env.BROWSER_USE_CHROME_PATH?.trim();
  if (override) {
    if (await deps.isExecutable(override)) {
      return { executablePath: override, browserName: "configured browser" };
    }
    throw new BrowserUseError("INTERNAL", `Configured browser is not executable: ${override}`, {
      hint: "Check BROWSER_USE_CHROME_PATH or remove it to use automatic browser discovery.",
    });
  }

  const fixedCandidates =
    platform === "linux"
      ? linuxCandidates
      : platform === "darwin"
        ? macCandidates
        : platform === "win32"
          ? windowsCandidates(env)
          : [];
  const candidates = [...fixedCandidates, ...pathCandidates(platform, env)];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.executablePath)) continue;
    seen.add(candidate.executablePath);
    if (await deps.isExecutable(candidate.executablePath)) return candidate;
  }

  throw new BrowserUseError("INTERNAL", "No supported browser found on this system", {
    hint: "Install Chrome, Chromium, Edge, or Brave, or set BROWSER_USE_CHROME_PATH to a browser executable.",
  });
}
