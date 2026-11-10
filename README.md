# dpi-product

Durable agents that run on your machines, survive restarts, and are driven from a browser, a terminal or one `curl`.

The agent runtime is `pi-durable` **1.5.0**, pinned exactly; `NOTICE` lists the third-party packages this product embeds.

## What it is

Every machine runs one `backend` that owns its agents, their SQLite databases and their tools. Clients connect with a URL and a bearer token. The agent lives on the device, not in the client: close the browser, quit the terminal or restart the machine mid-tool and the run resumes from its last checkpoint.

```
device (backend :4780, SQLite, token)
  └─ session (one durable harness + one agent.sqlite + a working directory)
       └─ agent (a conversation: Main, a fork, or a subagent)
```

| Piece | Runs on | Owns |
|---|---|---|
| `apps/backend` | every device | harnesses, `catalog.sqlite`, one `agent.sqlite` per session, shared App State |
| `apps/sdk` | inside everything | the v1 wire contract, `DpiClient`, SSE reader, `AgentModel` / `SessionModel` reducers |
| `apps/hub` | your laptop `127.0.0.1:4781` | device registry, token-injecting proxy, multiplexed SSE, Vue client |
| `apps/tui` | any terminal | nothing: it reads a device URL and token and talks to the device directly |
| `apps/watch` | your desktop | nothing: same URL and token, but it only speaks up when a person is needed |
| `apps/bridge` | a small public host | nothing: it turns a chat mention into a signed hook call and posts the answer back |

## Quickstart

Prereqs: Node 24, `just`, `zsh`, and an API key (DeepSeek by default; OpenRouter optional).

```bash
cp .env.example .env                          # set DEEPSEEK_API_KEY
cp dpi-network.example.yaml dpi-network.yaml  # starts with only `local`

just install                                  # npm install for the six apps
just check                                    # types and unit tests, free and offline

just net up local                             # write ~/.dpi/backend.env with a token
just backend run                              # :4780
just hub build && just hub start              # :4781 (second terminal)
just tui attach local                         # or attach from the terminal (third terminal)
just watch follow local                       # banners when a turn ends or a task needs you
```

Set `DPI_PROVIDER: faux` in `dpi-network.yaml` to run the deterministic offline model instead of a real one.

## Commands

```bash
just                       # groups: net, backend, hub, tui, watch, bridge, test
just check                 # type checks and unit tests, every app
just backend run           # this machine's device server on :4780
just hub start             # web UI on :4781
just tui attach <device>[:<session>[:<agent>]]
just watch follow [<device>] [--notify stdout|webhook:<url>]
just net up <id>           # bring a device online (idempotent)
just net status            # probe every device
just test ui               # web suite against two faux devices
just test device <id>      # real-model suites on one device
just test e2e <id>         # TUI + web + restart mid-tool + fork
just bridge run            # signed chat triggers, see below
```

## Hooks and chat bridges

A hook is one scoped, signed door into one agent: a chat platform, a task board or CI can hand over a
requirement without ever holding the device token. Declare hooks in `~/.dpi/hooks.json` (template:
`apps/backend/hooks.example.json`, override with `DPI_HOOKS_FILE`):

```json
{
  "feishu-work": {
    "secret": "at least 32 random characters",
    "session": "work",
    "agent": "main",
    "prompt": "来自飞书群 {{chat}}（{{user}}）的需求：\n{{text}}",
    "whenBusy": "followUp"
  }
}
```

```bash
# The bridge signs this; a script can do the same. Timestamp is seconds, signature is sha256=<hex>.
# base = sha256("<ts>\n<METHOD>\n<url>\nsha256(<body>)"), signature = HMAC-SHA256(secret, base)
curl -X POST http://127.0.0.1:4780/v1/hooks/feishu-work \
  -H "x-dpi-event: <unique id, the idempotency key>" \
  -H "x-dpi-hook-timestamp: <seconds>" -H "x-dpi-hook-signature: sha256=<hex>" \
  -d '{"text":"PAY-142 修一下登录","chat":"oc_123","waitMs":60000}'
```

`202` means queued (`{submissionId}`); `waitMs` blocks up to five minutes and answers `{status, answer}` instead.
`GET /v1/hooks/<name>/submissions/<id>?waitMs=` reads a run back later, signed the same way, so a bridge that
must answer a platform in three seconds can reply first and collect the result afterwards. Repeating an
`x-dpi-event` replays the stored response instead of starting a second run.

`GET /v1/hooks/<name>/approvals` lists job runs parked in an approval phase and
`POST /v1/hooks/<name>/approvals/<taskId>` with `{"approved":true}` decides one, both signed the same way.
Deliveries are capped per hook (`"limit": 20` per minute by default) and answer `429` with `Retry-After`; a retry
of a known event is free.

Feishu is the first adapter (`apps/bridge`, config in `bridge.yaml`, template `bridge.example.yaml`): it answers
the URL challenge, decrypts and verifies events, strips `@` mentions, maps `chat_id` to a hook name, replies on
the triggering message, and while a run waits it posts an approval card whose buttons decide the run
(`feishu.cards`, with `feishu.approvers` to restrict who may press them). Point the app's event subscription and
card callback at `https://<host>/feishu/events`.

A reply the bridge still owes a chat is written to `state.file` (`bridge-state.json` next to the config) before
the bridge waits, so a restart, a crash or a deploy answers it afterwards instead of losing it; a submission the
device no longer knows is forgotten rather than retried forever.

A hook secret is not the device token: it reaches one agent and nothing else, and removing it from
`hooks.json` ends that integration. The device stays on localhost; only the bridge is public.

## Languages

Every surface speaks English and Chinese: the hub, the terminal client, the watcher and the notifications it
sends. Each one follows the machine (`LANG`, or the browser's own preference), and `DPI_LANG` overrides all of
it:

```bash
DPI_LANG=zh just hub build && DPI_LANG=zh just hub start   # the hub has the last word and hides its picker
DPI_LANG=zh just tui attach local
DPI_LANG=zh just watch follow local
```

The hub remembers a language picked in the top bar in its own `ui_state`, so it survives a reload.
A missing or empty translation falls back to English rather than blanking a screen, and `just check` fails
if the two catalogs stop carrying the same keys.

Runtime data lives in `~/.dpi` by default. To keep an existing 1.0.3 device untouched, point a second instance elsewhere:

```bash
DPI_ENV_FILE=~/.dpi-product/backend.env npx tsx src/main.ts   # in apps/backend
# that env file holds DPI_TOKEN, DPI_PORT, DPI_DATA_DIR, DPI_START_DIRS and the provider keys
```

pi-durable 1.4+ migrates the SQLite schema to v2 and **cannot be rolled back**; back up any data dir you care about.

Devices are data: `dpi-network.yaml` declares each one by kind (`local`, `ssh`, `exe-dev`, `url`). No code or recipe names a machine, and tokens never live in the YAML.

## Guarantees and boundaries

- Closing a client never stops work. A backend restart resumes unfinished tasks from their checkpoints. Replay-safe tools rerun; unsafe ones return an interrupted result.
- Agent streams are derived from pi-durable conversation views: one `snapshot` on attach, then `view` deltas (appended entries, the live generation, tool slots). Reconnecting always gets a fresh snapshot and no replay.
- A token holder has the agent's shell and filesystem access on that device. Start dirs are where sessions begin, not a sandbox.
- `backend` binds `127.0.0.1` unless told otherwise.
- `pi-durable` is experimental: every minor version may break the API. Versions are pinned exactly and `package-lock.json` is committed.

## License

MIT. See `LICENSE` and `NOTICE`.
