# Browser Use MCP

Let an AI agent control a browser through an
[MCP](https://modelcontextprotocol.io) server. Use the extension to connect tabs in your existing
browser, or launch a separate headless browser with its own Browser Use profile. The agent can read
pages, click, type, upload and download files, handle dialogs, and inspect console and network
activity.

> **Status: pre-release.** It is built and tested, but not published yet. Today you run it from a
> local build (see [Install](#install)). Tested on Linux with Chromium and Brave; macOS and Windows
> are covered by CI but not yet by manual runs.

## How it works

```
 MCP client ──stdio──▶ browseruse-mcp ──local socket──▶ background daemon ──┬──WebSocket──▶ extension ──CDP──▶ your tabs
 (Claude, Cursor, …)   (one per client)                  (shared, auto-started) └──private pipe──▶ launched Chromium
```

- Each MCP client starts its own thin `browseruse-mcp` process. They all share one background daemon,
  which starts on demand and exits when idle.
- The extension drives tabs with the Chrome debugger protocol, restricted to an explicit allowlist of
  methods.
- Launch mode controls a separate local browser over a private CDP pipe; it never attaches to your
  everyday browser profile.
- You stay in control: the extension connects to the daemon only while you have a tab connected (or
  you turn on the setting that lets the agent open tabs).

## Requirements

- Node.js 22 or newer
- pnpm (to build from source)
- A Chromium-based browser: Chrome, Chromium, Edge or Brave

## Install

```sh
git clone <this repository> browseruse && cd browseruse
pnpm install
pnpm build
```

### 1. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) and turn on **Developer mode**.
2. Choose **Load unpacked** and select `packages/extension/dist`.

The extension has a fixed ID (`ongnlibadmoldpeiajghjilemklmkldc`); the daemon only accepts connections
from that origin.

### 2. Pair it

```sh
pnpm pair
```

This prints an 8-character, single-use code that expires after 5 minutes. Click the extension icon and
enter it. Pairing stores a token in the extension and `~/.browser-use/token` on this machine.

### 3. Connect a tab

Open the page you want the agent to use, click the extension icon, and press **Connect**. The popup
shows how many tabs are connected. Tabs the agent opens itself join a "Browser Use" tab group
automatically.

By default nothing is connected, and the extension holds no connection to the daemon. If you want the
agent to be able to open tabs on its own, open the popup's **Settings** and turn on
**Let the agent open tabs (keep connected)**. It is off by default.

### 4. Add the server to your MCP client

Use the absolute path to `packages/server/dist/cli.js` in your checkout. With no arguments it starts
the MCP server on stdio.

**Claude Code**

```sh
claude mcp add browser-use -- node /absolute/path/to/browseruse/packages/server/dist/cli.js
```

Add `--scope user` to make it available in every project. Restart the session, then check `/mcp`.

**opencode** (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browser-use": {
      "type": "local",
      "command": ["node", "/absolute/path/to/browseruse/packages/server/dist/cli.js"],
      "enabled": true
    }
  }
}
```

**Cursor / Claude Desktop / other stdio clients**

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/absolute/path/to/browseruse/packages/server/dist/cli.js"]
    }
  }
}
```

Several clients can be configured at once; they share the same daemon.

## Tools

All tools are named `browser_*`. Tools that act on an element accept a `ref` from `browser_snapshot`
**or** a CSS `selector`.

| Area                | Tools                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status and tabs     | `browser_status`, `browser_tabs`, `browser_open_tab`, `browser_close_tab`                                                                                                                     |
| Navigation          | `browser_navigate`, `browser_reload`, `browser_back`, `browser_forward`, `browser_stop`, `browser_wait`                                                                                       |
| Reading the page    | `browser_snapshot` (compact accessibility tree with refs), `browser_dom_snapshot`, `browser_accessibility_snapshot`, `browser_query`, `browser_screenshot`, `browser_pdf`, `browser_evaluate` |
| Interaction         | `browser_click`, `browser_type`, `browser_fill`, `browser_select`, `browser_hover`, `browser_focus`, `browser_scroll`, `browser_press_key`, `browser_drag`                                    |
| Files and dialogs   | `browser_upload`, `browser_downloads`, `browser_handle_dialog`                                                                                                                                |
| Diagnostics         | `browser_console`, `browser_network`, `browser_clear_diagnostics`, `browser_performance`, `browser_trace`                                                                                     |
| Storage and context | `browser_cookies`, `browser_storage`, `browser_emulate`, `browser_reset_emulation`                                                                                                            |

Things worth knowing:

- **Dialogs.** If a page opens an alert, confirm, prompt or "leave site?" dialog, other commands on
  that tab fail with `DIALOG_OPEN` until the agent calls `browser_handle_dialog`.
- **Console and network** are recorded from the first `browser_console` or `browser_network` call on a
  tab, so call them before the action you want to observe.
- **Background tabs.** Browsers ignore input to hidden tabs, so acting on a background tab switches to it
  (the window is not raised).
- **Pointer overlay.** A small pointer shows where the agent is clicking. Set `BROWSER_USE_POINTER=0` to
  turn it off.
- **Cross-origin iframes** are not included in `browser_snapshot` yet.

## Security model

- The daemon listens on `127.0.0.1` only and accepts WebSocket connections solely from the pinned
  extension origin with the exact `Host` header.
- Authentication uses a 256-bit token (file mode 0600) and single-use pairing codes, compared in
  constant time, with rate limiting on failures.
- The agent only sees tabs you connected, plus tabs it opened itself. `browser_open_tab` accepts only
  `http`, `https` and `about:blank`.
- The extension sends only allowlisted CDP methods, each with validated parameters; cookie and storage
  access is limited to the connected tab's site.
- Cookie values are never returned. Network capture caps body sizes and redacts `Set-Cookie`.
- The local IPC socket and the state directory (`~/.browser-use`) are owner-only. Anything running as
  your user can talk to the daemon, so treat it like any local credential file. See the design notes
  for the trust model.

Only one browser can be connected at a time. A second browser is refused with a clear message instead
of replacing the first.

## Command line

```sh
browseruse-mcp status [--json]   # daemon, extension and connected tabs
browseruse-mcp doctor            # diagnose setup problems and suggest fixes
browseruse-mcp pair [--reset]    # print a pairing code (--reset issues a new token)
browseruse-mcp stop              # stop the background daemon
browseruse-mcp daemon            # run the daemon in the foreground
```

From a source checkout, run these as `node packages/server/dist/cli.js <command>`.

## Configuration

| Variable                   | Default          | Purpose                                                        |
| -------------------------- | ---------------- | -------------------------------------------------------------- |
| `BROWSER_USE_HOME`         | `~/.browser-use` | State directory: token, log, lock, IPC socket                  |
| `BROWSER_USE_PORT`         | `38241`          | Loopback port for the extension connection                     |
| `BROWSER_USE_MODE`         | `extension`      | `extension`, `headless`, or `auto`                             |
| `BROWSER_USE_PROFILE`      | `default`        | Dedicated persistent profile (`default`) or disposable `guest` |
| `BROWSER_USE_CHROME_PATH`  | auto-discovered  | Optional path to a local Chrome/Chromium/Edge/Brave executable |
| `BROWSER_USE_POINTER`      | on               | Set to `0` to disable the pointer overlay                      |
| `BROWSER_USE_EXTENSION_ID` | pinned ID        | Override the allowed extension ID (development builds only)    |

If you change the port, set the same port in the extension (`chrome.storage.local` key `port`).
The daemon log is `~/.browser-use/daemon.log`.

### Browser mode and profile

Set these variables in the MCP server process configuration. For example, in an MCP server config
that supports an `env` object:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/absolute/path/to/browseruse/packages/server/dist/cli.js"],
      "env": {
        "BROWSER_USE_MODE": "auto",
        "BROWSER_USE_PROFILE": "default"
      }
    }
  }
}
```

- `extension` (default) controls tabs connected through the extension and never launches a browser.
- `headless` launches a local browser directly; no extension or pairing is required.
- `auto` prefers the extension at daemon startup, then launches headless if the extension is not
  ready within five seconds. It does not switch browsers if the extension disconnects mid-session;
  calls report the disconnect instead.
- `BROWSER_USE_PROFILE=default` automatically creates and retains a dedicated profile under
  `~/.browser-use/profile`, separate from your everyday browser profile. Site logins and state in
  this dedicated profile persist between daemon runs.
- `BROWSER_USE_PROFILE=guest` requests a disposable guest session. Guest mode support varies by
  browser/platform; unsupported combinations produce an error instead of silently using the
  persistent profile.
- Browser Use discovers a local Chrome, Chromium, Edge, or Brave installation. Set
  `BROWSER_USE_CHROME_PATH` to select a specific executable. Browser binaries are not downloaded.
- MCP clients share one daemon. Keep mode/profile settings consistent across clients; to change
  them, run `browseruse-mcp stop` and restart the MCP client with the new settings. A conflicting
  client receives a configuration error rather than silently using the other client's browser.

Headless and guest profiles can behave differently from an established everyday profile on websites.
Headless mode is not a CAPTCHA solver or bypass.

## Troubleshooting

Run `browseruse-mcp doctor` first; it checks the state directory, token, daemon, extension connection
and port, and says what to fix.

| Symptom                                       | Likely cause and fix                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Popup says **Off**                            | Nothing is connected. Press **Connect** on a tab, or enable the setting that lets the agent open tabs. |
| `BRIDGE_DISCONNECTED` from `browser_open_tab` | No tab is connected and the always-connected setting is off. Connect a tab or turn the setting on.     |
| Popup says **Another browser is connected**   | Another browser with the extension holds the connection. Disconnect its tabs or close it.              |
| Popup says **Local server not reachable**     | The daemon is not running or the port differs. Start your MCP client, or run `browseruse-mcp status`.  |
| "Not paired" or invalid code                  | Run `pnpm pair` (or `browseruse-mcp pair --reset`) and enter the new code in the popup.                |
| `DIALOG_OPEN`                                 | The page has a dialog open. Call `browser_handle_dialog` with `accept` true or false.                  |
| Extension changes not picked up               | Rebuild with `pnpm build`, then reload the extension in `chrome://extensions`.                         |

## Development

```sh
pnpm install
pnpm check        # lint, typecheck, unit tests, build
pnpm test:e2e     # end-to-end suite against real Chromium (build first)
pnpm format       # prettier
```

The repository is a pnpm monorepo:

- `packages/protocol` — wire and IPC message schemas, error codes (bundled into the server)
- `packages/server` — the `browseruse-mcp` CLI, daemon, MCP tools
- `packages/extension` — the Manifest V3 extension (Vite)

The extension must import `src/zod-jitless.ts` before anything that uses the protocol package;
Manifest V3 forbids `eval`, and a build test enforces the ordering.

## License

Not yet decided.
