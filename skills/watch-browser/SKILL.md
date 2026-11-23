---
name: watch-browser
description: Use when you start testing or driving a web page with the chrome-devtools tools and the user may want to watch it live — tells them the termbrowse command that shows your browser in a terminal pane.
---

Your `chrome-devtools` tools drive a Chrome for Testing that termbrowse started for you alone. The user can watch it live in a terminal that draws Kitty graphics (Kitty, Ghostty, Herdr).

## Tell the user once

When you first open a page they would want to see, give them the command with your agent id filled in:

```sh
termbrowse view --agent <id>
```

Find `<id>` with a shell command: `$TERMBROWSE_AGENT` if set, else `$HC_TERMINAL_ID` (in Herdr), e.g. `echo "${TERMBROWSE_AGENT:-$HC_TERMINAL_ID}"`. If both are empty, your id is `pid-<pid>`; have the user run `termbrowse agents` to see it.

The viewer only shows the page; you keep driving it. If it says no browser is running, open a page first and have them run it again.

## Only in Herdr (`HC_TERMINAL_ID` is set)

Offer to open the viewer in a pane beside your own. This splits your pane even if another pane has focus:

```sh
pane=$(herdr-app ls | jq -r --arg t "$HC_TERMINAL_ID" \
  '[.spaces[].tabs[].terminals[] | select(.terminal == $t) | .pane][0] // empty')
herdr-app do pane.split --direction right ${pane:+--pane $pane} \
  --argv "[\"termbrowse\",\"view\",\"--agent\",\"$HC_TERMINAL_ID\"]"
```

Run it after your first browser action, and only when the user wants it. Outside Herdr, don't try to open panes.
