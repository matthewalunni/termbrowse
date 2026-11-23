# termbrowse

termbrowse draws a live Chrome tab inside your terminal with the Kitty graphics protocol. It also gives each AI coding agent its own Chrome for Testing through an MCP server, so you can watch any agent's browser in a pane next to it. It never touches your everyday Google Chrome or its profile. It downloads and uses Chrome for Testing, keeps one profile per agent, and lets you sign in once with `termbrowse login` so new agent profiles start signed in.

<!-- TODO: add a recording of the viewer in a pane (docs/demo.gif) and show it here. -->

The viewer is interactive: click, scroll, type and paste into the page from the terminal (see [Using the page](#using-the-page)). On an agent's browser, the first thing you do takes control from the agent until you hand it back.

## Install

termbrowse is not on npm. Install it from a checkout (Node 22 or newer, macOS or Linux):

```sh
git clone git@github.com:matthewalunni/termbrowse.git
cd termbrowse
npm ci
npm link          # puts `termbrowse` on your PATH
termbrowse doctor
```

Chrome for Testing downloads to `~/.cache/termbrowse` the first time something needs it (about 150 MB).

## Three ways to use it

### 1. `termbrowse <url>`: a browser in this terminal

```sh
termbrowse example.com
termbrowse localhost:3000        # localhost and 127.0.0.1 get http://
```

This starts a Chrome for Testing of its own and draws the page in the terminal. In a terminal that can't draw Kitty graphics it says so and exits 2 before starting any Chrome. Press `q` or Ctrl-C to quit, which closes that Chrome (until you first click, type, scroll or paste: after that those keys go to the page, and you quit with the prefix key and `q`, see [Using the page](#using-the-page)). The last row is a status line with the URL and frames per second, `idle` when no frame came in the last second (Chrome only sends frames when the page changes), or `paused` (the pane is too small) or `disconnected` (Chrome went away). When a new tab opens (a popup, or a page an agent opens with `new_page`), the viewer switches to it, and when that tab closes it goes back to the tab it was showing before.

Each run uses a fresh copy of the starter profile (see `termbrowse login`), and that copy is deleted when you quit. Signing in during a `termbrowse <url>` session lasts only for that session. You can run several at once.

### 2. `termbrowse view`: watch a Chrome that is already running

```sh
termbrowse view --agent t2p             # the Chrome of agent t2p (see `termbrowse agents`)
termbrowse view --port 9222             # any Chrome with a debugging port on 127.0.0.1
termbrowse view --agent t2p --tab docs  # the tab whose URL or title contains "docs"
```

`--tab` picks the first tab whose URL or title contains the text, ignoring case. If no tab matches, the viewer shows the first tab.

Quitting the viewer leaves that Chrome running. On an agent's browser, your first click, key press, paste or scroll takes control from the agent (see [Taking over from an agent](#taking-over-from-an-agent)). If the agent has no browser yet, `view --agent` says so and exits 1. An agent's Chrome only starts on its first browser action.

### 3. `termbrowse mcp`: one Chrome per agent

`termbrowse mcp` is an MCP server (stdio). It runs [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (pinned to 1.13.0) against a Chrome for Testing that belongs to one agent. That Chrome starts on the agent's first browser tool call, not when the MCP server starts. The agent's tool list is available immediately.

Which agent it is, in this order: `$TERMBROWSE_AGENT`, then `$HC_TERMINAL_ID` (Herdr's terminal id), then `pid-<parent pid>`. A new agent's profile is copied from the starter profile.

An agent named by `TERMBROWSE_AGENT` or `HC_TERMINAL_ID` keeps its own profile across MCP restarts and sessions, so its sign-ins and cookies stay (until it is unused for `prune_days`). A `pid-<parent pid>` profile belongs to that one agent process: once the process has exited, the next termbrowse command deletes it. Outside Herdr, set `TERMBROWSE_AGENT` in the MCP server's environment to keep an agent's profile from one session to the next, e.g. `"env": { "TERMBROWSE_AGENT": "reviewer" }` in `.mcp.json`.

Claude Code:

```sh
claude mcp add termbrowse -- termbrowse mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "termbrowse": { "command": "termbrowse", "args": ["mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`). Naming the server `chrome-devtools` replaces an existing chrome-devtools-mcp entry of that name, so the agent keeps the tool names it knows and gets only one browser server:

```toml
[mcp_servers.chrome-devtools]
command = "termbrowse"
args = ["mcp"]
```

For Claude Code, the plugin below sets this up for you.

Arguments after `--` go to chrome-devtools-mcp: `termbrowse mcp -- --some-flag`.

When the agent exits, its Chrome closes. If the MCP process is killed without cleaning up (SIGKILL, a crash), its Chrome is closed by the next termbrowse command that reads the list of browsers (`agents`, `stop`, `view --agent`, `mcp`, `termbrowse <url>`).

## Claude Code plugin

This repository is also a Claude Code plugin. The plugin doesn't contain a copy of termbrowse: its MCP server runs the `termbrowse` command from your PATH, so install the CLI first (see [Install](#install)) and check that `termbrowse doctor` reports `termbrowse on PATH: ok`.

Then add this repository as a marketplace and install the plugin:

```sh
claude plugin marketplace add matthewalunni/termbrowse   # or the path to your checkout
claude plugin install termbrowse@termbrowse
```

The plugin provides:

- an MCP server named `chrome-devtools` that runs `termbrowse mcp`, so each agent gets its own Chrome for Testing. Its tools are called `mcp__plugin_termbrowse_chrome-devtools__<tool>`.
- the skills from Google's chrome-devtools-mcp plugin (`chrome-devtools`, `a11y-debugging`, `cookie-debugging`, `debug-optimize-lcp`, `memory-leak-debugging`, `troubleshooting`), copied unchanged from version 1.11.0. Its `chrome-devtools-cli` skill is left out because it drives Google's separate `chrome-devtools` CLI, not termbrowse.
- `watch-browser`, a skill that has the agent tell you the `termbrowse view --agent <id>` command for its browser and, in Herdr, offer to open it in a pane beside its own. It also has the agent ask you to take over when it is stuck on a login, 2FA or CAPTCHA, and carry on once you hand the browser back.

If you have Google's `chrome-devtools-mcp` plugin installed, disable it (`claude plugin disable chrome-devtools-mcp@claude-plugins-official`). Otherwise each agent gets two browser servers with the same tools: Google's, which drives a Chrome of its own that termbrowse can't show, and termbrowse's. You could switch off just its server in `/mcp`, but its skills would still load next to the copies in this plugin, so disabling the whole plugin is simpler.

The copied skills are © Google LLC under the Apache License 2.0; see [`skills/NOTICE`](skills/NOTICE) and [`skills/LICENSE-APACHE-2.0`](skills/LICENSE-APACHE-2.0). The plugin files (`.claude-plugin/`, `skills/`) aren't part of the npm package.

## Other commands

```sh
termbrowse agents [--json]          # live Chromes: AGENT  KIND  PORT  PID  URL
termbrowse stop --agent ID          # close one agent's Chrome
termbrowse stop --all               # close every Chrome termbrowse started
termbrowse login [url] [--reset]    # sign in once, for every new profile
termbrowse doctor                   # check Node, config, Chrome, display, libraries, PATH, terminal
termbrowse --version
```

`stop --agent` on an MCP agent closes its Chrome. The wrapper starts a new one on the agent's next browser tool call.

## `termbrowse login`

```sh
termbrowse login github.com
```

This opens a normal Chrome for Testing window (even when `headless = true`) on the starter profile. Sign in to the sites your agents need, then press Enter in the terminal or close the browser window.

termbrowse then prints `Saving your sign-ins…` and keeps Chrome running for 35 seconds before closing it. Chrome writes cookies to disk on a timer of about 30 seconds, not when it quits. In a test, a cookie set 3 seconds before closing never reached the disk. Ctrl-C during the wait asks once more, and a second Ctrl-C quits at once, which may lose recent sign-ins.

- New agent profiles and every `termbrowse <url>` run start from a copy of this profile. Agents that already have a profile keep their own sign-ins and don't pick up new ones. To give an existing agent the new sign-ins, delete its folder under `~/.local/state/termbrowse/profiles/`.
- `--reset` deletes the starter profile first.
- Login needs a display. On Linux without `DISPLAY` or `WAYLAND_DISPLAY` it exits 1. Sign in on a machine with a screen instead.
- On macOS, termbrowse starts every Chrome with a mock keychain (`--use-mock-keychain`), so it never prompts for Keychain access. Its saved logins live only in termbrowse's own profiles, not in your Keychain, and every termbrowse profile uses the same cookie key, so a profile copied from the starter still reads the starter's cookies. A starter profile signed in before termbrowse used the mock keychain may lose those sign-ins (its cookies were encrypted with the Keychain key): if so, run `termbrowse login --reset` and sign in again.

## Configuration

termbrowse reads `$TERMBROWSE_CONFIG` or, if that is unset, `$XDG_CONFIG_HOME/termbrowse/config.toml` (default `~/.config/termbrowse/config.toml`). The file is optional. These are all the keys, with their defaults:

```toml
[chrome]
channel = "stable"          # Chrome for Testing channel: stable, beta, dev, canary
headless = false            # forced true on Linux with no DISPLAY / WAYLAND_DISPLAY
background = true           # macOS: open agent and `termbrowse <url>` windows without taking focus
window_size = "1280x800"    # agent and standalone window size, "WIDTHxHEIGHT"
extra_args = []             # extra Chrome flags, e.g. ["--lang=en-US"]

[agents]
prune_days = 7              # delete agent profiles unused for this many days

[hooks]
on_launch = ""              # shell command run after a termbrowse Chrome starts

[view]
fill_pane = true             # pages opened with `termbrowse <url>` (and `view --port` on such a browser) fill the pane
fill_pane_for_agents = false # agent browsers fill the pane too (`view --agent`, `view --port` on an agent's port)

[keys]                       # reserved keys of the viewer, see "Using the page"
prefix = "ctrl-]"
give_back = "g"
quit = "q"

[control]                    # taking over an agent's browser, durations like "90s", "5m", "2h"
idle_return = "5m"           # hand the browser back after this long without input
max_wait = "10m"             # the longest an agent's tool call waits while you hold control
```

On macOS, agent windows and `termbrowse <url>` windows open in the background, so they don't steal focus from your terminal (or pull a window manager that follows focus onto their workspace). Set `background = false` to have them come to the front as they open. `termbrowse login` always comes to the front, since you type into it.

`on_launch` runs with `sh -c` once the new Chrome has a page. Its environment has these variables:

- `TERMBROWSE_PID`: Chrome's pid.
- `TERMBROWSE_PORT`: Chrome's debugging port.
- `TERMBROWSE_AGENT`: the agent id. It is empty for `termbrowse <url>`.
- `TERMBROWSE_KIND`: `agent` or `standalone`.
- `TERMBROWSE_HEADLESS`: `1` if this Chrome is headless (no window), else `0`.
- `TERMBROWSE_BUNDLE_ID`: `com.google.chrome.for.testing` on macOS, empty on Linux.

The hook runs in the background, so it doesn't delay the agent or the viewer. A hook that fails is logged to `~/.local/state/termbrowse/logs/hook.log`, and it never stops termbrowse. A hook that runs longer than 10 seconds is killed along with its children, so start longer work with `nohup` or `setsid`. Window-manager recipes (AeroSpace, yabai, Hyprland) are in [docs/hooks.md](docs/hooks.md).

Other environment variables:

| Variable | Effect |
| --- | --- |
| `TERMBROWSE_AGENT` | agent id for `termbrowse mcp` (overrides `HC_TERMINAL_ID`) |
| `TERMBROWSE_ASSUME_KITTY=1` | treat the terminal as able to draw Kitty graphics without asking it |
| `TERMBROWSE_CONFIG` | path of the config file |
| `XDG_STATE_HOME` | state: registry, profiles, logs (default `~/.local/state/termbrowse`) |
| `XDG_CACHE_HOME` | Chrome for Testing downloads (default `~/.cache/termbrowse`) |

## Using the page

The viewer forwards what you do in the pane to the page, in any terminal that draws Kitty graphics (below). Only the image area counts: the status row and any empty margin around the image do nothing.

- **Mouse**: click (left, middle, right), double and triple click, drag and scroll wheel all reach the page. Moving the pointer alone never takes control of an agent's browser; hover is forwarded to the page while you hold control (on a browser started by `termbrowse <url>`, always).
- **Keys**: letters, digits, punctuation, Enter, Tab, Backspace, Escape, arrows, Home, End, PageUp, PageDown, Insert, Delete and F1 to F12, with Ctrl, Alt and Shift. Terminals without the Kitty keyboard protocol work for plain typing, Enter, Backspace and arrows; modified keys are more reliable in Kitty, Ghostty and Herdr. Accented letters, emoji and other non-ASCII text are inserted as text.
- **Paste**: bracketed paste goes into the focused field in one piece.

Before your first input, `q` and Ctrl-C quit the viewer, as before. After it they go to the page (so you can type a `q` into a search box), and the viewer is left with the reserved keys, or with a signal (SIGINT, SIGTERM, SIGHUP, e.g. closing the pane).

### Reserved keys

Press the **prefix** key, then one more key within 2 seconds. The status row shows `prefix…` while it waits.

| Keys | Does |
| --- | --- |
| prefix, `g` (`give_back`) | hand an agent's browser back to the agent (nothing to hand back on a browser you started yourself) |
| prefix, `q` (`quit`) | quit the viewer |
| prefix, prefix | send the prefix key itself to the page |
| prefix, anything else | cancels the prefix |

The defaults are `ctrl-]`, `g` and `q`. Rebind them in `[keys]`: a key is a single character or a name (`escape`, `tab`, `enter`, `space`, `f1` to `f12`), optionally with `ctrl-` and `alt-` in front, e.g. `prefix = "ctrl-b"` or `give_back = "alt-g"`. A key that doesn't parse stops termbrowse with an error naming the file and the key.

### Taking over from an agent

Control applies to agent browsers only (`view --agent ID`, or `view --port` on an agent's port). A browser started by `termbrowse <url>` is always yours and never has a hand-back. The first mouse press, key press, paste or scroll in the pane takes control. Then:

- The status row reads `you have control · Ctrl-] g to hand back`, with the keys from your config. While the agent holds the browser, it reads `agent · <url> · <fps>`. If the agent was in the middle of an action when you took control, the row says `agent was acting…` for about 2 seconds.
- The agent's browser tool calls wait: `termbrowse mcp` holds each call until you hand the browser back. Nothing is dropped, and calls that need no browser (the tool list, for example) still answer.
- You hand the browser back with the prefix and `give_back` keys, by quitting the viewer, or by leaving it idle for `idle_return` (default 5 minutes). If the viewer process dies, the agent notices within about a second.
- The agent's first result after you hand back carries an extra text item: `Note from termbrowse: the user took control of this browser for <duration> (<while you waited|since your last action>). The page may have changed; it is now at <url>. Re-check the page (e.g. take a snapshot) before continuing.`
- If you keep control for longer than `max_wait` (default 10 minutes) while a call waits, that call fails with the MCP error `termbrowse: the user has control of the browser; try again later` (code -32000), and the agent can try again.
- If termbrowse can't write the control file, the viewer says `couldn't take control: <reason>` and the agent isn't blocked. Your input still reaches the page.

Warning: the agent's tool call may time out on its own side before `max_wait`, because the call really is held. Raise your agent's MCP tool timeout, or lower `max_wait`:

- Claude Code: set `MCP_TOOL_TIMEOUT` (milliseconds, for every server) or `"timeout"` in milliseconds on the server's entry in `.mcp.json`. When neither is set, Claude Code's own limit is about 28 hours, so this is only a problem if you've lowered it.
- Codex: `tool_timeout_sec` on the server in `~/.codex/config.toml`. Its default is 60 seconds, shorter than most takeovers, so raise it (for example `tool_timeout_sec = 900`) if agents run in Codex.
- Any other client: check your agent's MCP tool timeout setting.

## Filling the pane

By default the viewer draws the page at the browser's own window size, scaled down to fit the pane, so it may leave empty space at the sides or bottom. When filling, the viewer tells Chrome to lay the page out at the pane's size instead (pane width × the height above the status row). It does this again when the pane is resized or the viewer switches tabs, and undoes it when you quit or switch away.

- `fill_pane = true` (the default) fills the pane for browsers started by `termbrowse <url>`.
- `fill_pane_for_agents = true` fills the pane for agent browsers too.
- `view --port` on a Chrome termbrowse did not start (your own Chrome) never fills unless you pass `--fill`.
- `--fill` / `--no-fill` on `termbrowse <url>` and `termbrowse view` override the config for that run.

Warning: with `fill_pane_for_agents = true`, an agent's page takes your pane's size while you watch it. Its layout, and the screenshots the agent takes, then depend on the size of your pane.

Two viewers on the same page (say `view --agent a1` in two panes) share one size override, because Chrome keeps one per page: the viewer that set it last wins, and the other draws the page at that size, scaled to fit. When either viewer quits it removes the override for both, and the one still open sets it again on its next resize.

## Terminal support

The viewer needs the Kitty graphics protocol. Before drawing, termbrowse checks the terminal:

1. It recognises Herdr (`HC_TERMINAL_ID`), Kitty (`KITTY_WINDOW_ID`, `TERM=xterm-kitty`) and Ghostty (`TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty`) from their environment variables.
2. If it doesn't recognise the terminal, it sends the Kitty graphics query and waits for an answer.

Herdr draws Kitty graphics but doesn't answer the query, which is why step 1 exists. If your terminal draws Kitty graphics but isn't recognised and doesn't answer, set `TERMBROWSE_ASSUME_KITTY=1`. In a terminal without Kitty graphics, the viewer prints a message and exits 2 without drawing anything.

| Terminal | Status |
| --- | --- |
| Herdr (macOS) | watching confirmed by eye (2026-11-23): sharp, undistorted, follows new tabs, fills the pane, scrolls smoothly without flicker. Clicking and typing in the pane: expected to work; not yet confirmed |
| Herdr terminal on a remote Linux machine | the viewer runs and writes frames (31 fps measured on `dev`); not yet confirmed that the image shows up on the Mac; clicking and typing over ssh: expected to work; not yet confirmed |
| Kitty, Ghostty | expected to work; not yet confirmed (including clicking and typing) |
| WezTerm | Kitty graphics are off by default; with `enable_kitty_graphics = true` it answers the query (not tested) |
| macOS Terminal.app, iTerm2 | not supported (no Kitty graphics); the viewer refuses to start |

The image is drawn at the pane's real pixel size (1×, never Retina 2×) from PNG frames. Large frames lower the frame rate automatically.

## Herdr

- In a Herdr terminal, the agent id is the terminal's id (`HC_TERMINAL_ID`, e.g. `t2p`). An agent running `termbrowse mcp` from that terminal gets a Chrome named after it, so `termbrowse agents` lists it as `t2p`.
- To watch an agent's browser in a pane next to it, split a pane. `pane.split` splits the focused pane unless you pass `--pane <id>`; this looks up the pane of the terminal it runs in (`HC_TERMINAL_ID`), so it splits the agent's own pane even when another pane has focus:

  ```sh
  pane=$(herdr-app ls | jq -r --arg t "$HC_TERMINAL_ID" \
    '[.spaces[].tabs[].terminals[] | select(.terminal == $t) | .pane][0] // empty')
  herdr-app do pane.split --direction right ${pane:+--pane $pane} \
    --argv "[\"termbrowse\",\"view\",\"--agent\",\"$HC_TERMINAL_ID\"]"
  ```

  If the agent hasn't opened a browser yet, the viewer says so and exits. Run it again after the agent's first browser action.
- Closing a pane sends SIGHUP. The viewer and `termbrowse mcp` both handle it: they close their Chrome and restore the terminal.

## Linux

termbrowse was checked on a headless Debian 13 (trixie) x86_64 machine (Herdr's `dev`):

- Node: Debian's `/usr/bin/node` is 20.19.2, which is too old. `doctor` reports `Node: fail (20.19.2; termbrowse needs 22 or newer)`. Use Node 22 or newer from nvm, NodeSource or similar. The check used Node 26.13.1 from nvm.
- Chrome libraries: a minimal Debian lacks the shared libraries Chrome needs. `doctor` lists the missing ones from `ldd`, followed by the `sudo apt install` line for the packages that provide them (Debian 13 / Ubuntu 24.04 names; any library it has no package for is named as-is). On Debian 13 they were:

  ```sh
  sudo apt-get install --no-install-recommends libnspr4 libnss3 libatk1.0-0t64 \
    libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libasound2t64 libcairo2 \
    libpango-1.0-0 libxdamage1 libatspi2.0-0t64
  ```

  On Debian 12 or Ubuntu 22.04, drop the `t64` suffixes.
- No display: with neither `DISPLAY` nor `WAYLAND_DISPLAY`, Chrome always runs headless (`--headless=new`), and `doctor` warns about it. `termbrowse login` can't run there, because it needs a window.
- On Linux, Chrome runs with `--password-store=basic`, so it doesn't need a desktop keyring.
- With Node 26 and those libraries, the full test suite passed (111/111). `termbrowse https://example.com` ran in a Herdr terminal on that machine: Chrome was headless, the status row showed 31 fps on an animated page, and quitting left no Chrome or profile behind.

## Security

- Chrome for Testing is a real, current Chrome. termbrowse looks up the channel's current build each time it starts a Chrome and downloads it if needed, so you get new security fixes. If that lookup fails or takes more than 3 seconds (offline), it uses the newest build already downloaded, which may be behind.
- Every debugging port binds to `127.0.0.1` only. It is never reachable from the network.
- A debugging port has no password. **Any program or user on the same machine can connect to it** and fully control that Chrome, including its signed-in sessions. Don't sign in to accounts you wouldn't let local processes use, and don't run termbrowse on a machine shared with people you don't trust.
- Profiles (with cookies) live under `~/.local/state/termbrowse/`, which termbrowse keeps private to your user (mode 0700). Treat that folder like a password store.

## License

MIT
