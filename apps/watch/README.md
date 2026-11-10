# watch

Desktop notifications for one DPI device, so nobody has to keep a browser tab open. It talks
to a device's `backend` over the [v1 API](../backend/API.md) with the device's bearer token, exactly like
[`tui`](../tui), and speaks only when a person is needed.

```bash
just watch follow mac-mini                 # banners on macOS, lines on stdout elsewhere
just watch follow                          # first device in ~/.dpi/network.sqlite
cd apps/watch && npm start -- --url https://my-vm.exe.xyz --token $DPI_TOKEN
```

Device ids come from `~/.dpi/network.sqlite`, seeded from the repo's `dpi-network.yaml`; tokens come from
`just net register <id>`. `--url/--token` (or `DPI_URL`/`DPI_TOKEN`) reach any backend, `DPI_DEVICE` names the
default device.

## What it says, and what it does not

| Event | Notice |
|---|---|
| an agent finished a turn | `✅ <session> / <agent> finished`, with a one-line preview |
| a task started waiting for approval or input | `⏸ <label> needs you` |
| the device stream dropped, and again when it returns | `⚠ device offline` / `✓ device back online` |
| everything else (starts, running tasks, streaming text) | nothing |

A notice has a stable `key` per event, so a reconnect replays no old banner. Session streams are opened per
session the tree reports and dropped without complaint: a closed session is not an incident. The device stream
retries every 3 s.

## Options

```
--notify osascript | stdout | webhook:<url>   osascript on macOS, stdout elsewhere
--verbose                                    also print started/finished lines
--once                                       exit after the first notice (smoke tests)
-h, --help
```

`webhook:` POSTs the `Notice` JSON (`key`, `title`, `body`, `at`) to a URL, which is how it reaches a phone or a
chat channel without adding a dependency.

Notifications arrive in the language the machine speaks: `LANG`, or `DPI_LANG=zh` to force Chinese.

## Layout

```
src/i18n.ts      the words, in both languages
src/watcher.ts   what is worth a notification, as a pure state machine (names, dedupe, transitions)
src/main.ts      args, device resolution, notifier choice, streams, reconnect
bin/watch.mjs    runs src/main.ts through tsx, for npm link or npx watch
```

## Tests

```bash
npm run check && npm test   # types; every notice rule, and every silence rule
```

From the repo root, `just watch check` and `just check` run the same.
