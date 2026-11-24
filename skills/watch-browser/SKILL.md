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

The viewer has vim-style keys (`?` shows them). The user can click and type into it. The first time they act on the page, they take control of your browser, and your browser tool calls wait until they hand it back. If it says no browser is running, open a page first and have them run it again.

## Only in Herdr (`HC_TERMINAL_ID` is set)

Offer to open the viewer in a pane beside your own. This splits your pane even if another pane has focus:

```sh
pane=$(herdr-app ls | jq -r --arg t "$HC_TERMINAL_ID" \
  '[.spaces[].tabs[].terminals[] | select(.terminal == $t) | .pane][0] // empty')
herdr-app do pane.split --direction right ${pane:+--pane $pane} \
  --argv "[\"termbrowse\",\"view\",\"--agent\",\"$HC_TERMINAL_ID\"]"
```

Run it after your first browser action, and only when the user wants it. Outside Herdr, don't try to open panes.

## When you are stuck on a login, 2FA or CAPTCHA

Don't guess credentials or try to get around it. Stop and tell the user, with your agent id filled in:

> I need you to sign in (or solve this check) in my browser. Run `termbrowse view --agent <id>`, click the field in the pane to take over and type, finish the step, then hand the browser back with `Esc` `Esc` (or type `:done` and Enter). `:q` and Enter quits the viewer. Tell me when you're done.

Once they say so, call a read-only tool such as `take_snapshot` to see where the page is, and carry on. If one of your tool calls seems to hang, the user probably has control: it resumes when they hand back, and fails after a while with "the user has control of the browser; try again later". If it fails that way, try again later. In Claude Code a call held for more than about 2 minutes moves to the background: don't call the tool again, wait for its task notification (it arrives when the user hands back). The first result after a takeover carries a "Note from termbrowse" saying the page may have changed: re-check the page before continuing.
