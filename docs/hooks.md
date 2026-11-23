# `on_launch` hook recipes

`[hooks] on_launch` in `~/.config/termbrowse/config.toml` runs a shell command (`sh -c`) every time termbrowse starts a Chrome, once that Chrome has a page. Use it to place agent windows where they won't get in your way. Its environment has these variables:

| Variable | Value |
| --- | --- |
| `TERMBROWSE_PID` | Chrome's main process id (the window owner) |
| `TERMBROWSE_PORT` | its debugging port on 127.0.0.1 |
| `TERMBROWSE_AGENT` | the agent id; empty for `termbrowse <url>` |
| `TERMBROWSE_KIND` | `agent` or `standalone` |
| `TERMBROWSE_HEADLESS` | `1` if this Chrome is headless (no window), else `0` |
| `TERMBROWSE_BUNDLE_ID` | `com.google.chrome.for.testing` on macOS, empty on Linux |

Rules:

- The hook runs in the background. A slow hook doesn't hold up the agent or the viewer.
- A hook that fails (non-zero exit, or can't start) is logged to `~/.local/state/termbrowse/logs/hook.log`. It never stops termbrowse.
- A hook still running after **10 seconds is killed** along with its child processes. For anything longer, detach it: `nohup my-script >/dev/null 2>&1 &` or `setsid my-script &`.
- Headless Chromes have no window. That includes Linux with no display, and `headless = true`. The recipes below then find nothing and do nothing. To skip them cleanly, start the hook with `[ "$TERMBROWSE_HEADLESS" = 1 ] && exit 0`.

A window may appear a moment after the page exists, so each recipe polls for up to about 3 seconds.

## AeroSpace (macOS)

Float each agent's Chrome and send it to workspace `S`. This recipe uses only AeroSpace commands. `list-windows --all --format '%{window-id} %{app-pid}'` was checked on AeroSpace 0.21.3-Beta, and `layout` and `move-node-to-workspace` both accept `--window-id` in that version. The full hook has not been run end to end.

```toml
[hooks]
on_launch = "sh ~/.config/termbrowse/aerospace-hook.sh"
```

`~/.config/termbrowse/aerospace-hook.sh`:

```sh
for i in 1 2 3 4 5 6 7 8 9 10; do
  w=$(aerospace list-windows --all --format '%{window-id} %{app-pid}' | awk -v p="$TERMBROWSE_PID" '$2==p{print $1; exit}')
  [ -n "$w" ] && break; sleep 0.3
done
[ -n "$w" ] && aerospace layout --window-id "$w" floating && aerospace move-node-to-workspace --window-id "$w" S
```

To place only agent Chromes and leave `termbrowse <url>` alone, start the script with `[ "$TERMBROWSE_KIND" = agent ] || exit 0`.

## yabai (macOS) (untested)

```sh
for i in 1 2 3 4 5 6 7 8 9 10; do
  w=$(yabai -m query --windows | jq -r --argjson p "$TERMBROWSE_PID" '[.[] | select(.pid == $p)][0].id // empty')
  [ -n "$w" ] && break; sleep 0.3
done
[ -n "$w" ] && yabai -m window "$w" --toggle float && yabai -m window "$w" --space 5
```

`--toggle float` flips the window's state. That is fine for a new window, which starts tiled.

## Hyprland (Linux) (untested)

```sh
for i in 1 2 3 4 5 6 7 8 9 10; do
  a=$(hyprctl clients -j | jq -r --argjson p "$TERMBROWSE_PID" '[.[] | select(.pid == $p)][0].address // empty')
  [ -n "$a" ] && break; sleep 0.3
done
[ -n "$a" ] && hyprctl dispatch setfloating "address:$a" && hyprctl dispatch movetoworkspacesilent "special:browsers,address:$a"
```

## Logging every launch

Useful when you're writing a hook:

```toml
[hooks]
on_launch = "echo \"$(date) $TERMBROWSE_KIND $TERMBROWSE_AGENT pid=$TERMBROWSE_PID port=$TERMBROWSE_PORT\" >> ~/.local/state/termbrowse/logs/launches.log"
```
