# the button simulator

### → [lanewinfield.github.io/thebutton-simulator](https://lanewinfield.github.io/thebutton-simulator/) ←

A faithful, browser-based recreation of [/r/thebutton](https://www.reddit.com/r/thebutton/),
reddit's April 2015 social experiment, that replays the **actual** historical
press timeline in real time.

The page reuses the original archived HTML, CSS, JavaScript and image assets
captured from the [Wayback Machine snapshot](https://web.archive.org/web/20150426001859/https://www.reddit.com/r/thebutton/),
and replaces the (now defunct) live websocket feed with a local shim that
schedules every one of the **1,008,315 historical button presses** at the same
timestamps they happened on April 1 – June 5, 2015.

Sidebar tier counts (purple/blue/green/yellow/orange/red, plus non-pressers and
cheaters) update live as the timeline advances.

## Controls

| Key | Action |
| --- | --- |
| `1`–`9`, `0` | Jump linearly through the timeline (`1` = start, `0` = 1 minute before end) |
| `←` / `→` | Skip back / forward 1 hour |
| `Space` | Pause / play |
| `,` / `.` | Slow down / speed up playback (1× to 200,000×) |
| `M` | Reset playback speed to 1× |
| `T` | Toggle the bottom scrubber bar |
| `L` | Jump to 80 seconds before the lowest historical timer value |
| `B` | Reset the button to pressable (after expire) |
| `E` | Force expire |
| `/` or `?` | Show / hide the help overlay |
| `Esc` | Close overlays |

At 200,000× the entire 65-day experiment plays in about 28 seconds.

## Running locally

```sh
# any static file server pointed at the repo root works
python3 -m http.server 8765
# open http://localhost:8765/
```

## Rebuilding the press timeline

The pre-built binary timeline (`assets/presses.bin`, `assets/flairs.bin`,
`assets/presses.meta.json`) is checked in. To regenerate from the original
source CSV:

```sh
git clone https://github.com/reddit/thebutton-data.git data
python3 build_presses.py
```

## Credits / sources

- [Wayback Machine archive of /r/thebutton (April 26, 2015)](https://web.archive.org/web/20150426001859/https://www.reddit.com/r/thebutton/) — every original asset.
- [reddit/thebutton-data](https://github.com/reddit/thebutton-data) — the press timeline CSV.
- [reddit/reddit-plugin-thebutton](https://github.com/reddit/reddit-plugin-thebutton) — the original server-side code.

## License

The recreation glue (`assets/local-button.js`, `build_presses.py`, this README)
is provided as-is for educational / nostalgic purposes. The original reddit
assets are reused under reddit's terms; press-timeline data is from
[reddit/thebutton-data](https://github.com/reddit/thebutton-data).
