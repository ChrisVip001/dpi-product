# dpi-product

Durable agents that run on your machines, survive restarts, and are driven from a browser, a terminal or one `curl`.

This repository is a product seed derived from [Durable Pi](https://github.com/indydevdan/durable-pi) (MIT, see `NOTICE`), with the proactive demo removed and the runtime migrated from `pi-durable` 1.0.3 to **1.5.0**.

## What it is

Every machine runs one `dpi-backend` that owns its agents, their SQLite databases and their tools. Clients connect with a URL and a bearer token. The agent lives on the device, not in the client: close the browser, quit the terminal or restart the machine mid-tool and the run resumes from its last checkpoint.

```
device (dpi-backend :4780, SQLite, token)
  └─ session (one pi-durable harness + one agent.sqlite + a working directory)
       └─ agent (a conversation: Main, a fork, or a subagent)
```

| Piece | Runs on | Owns |
|---|---|---|
| `apps/dpi-backend` | every device | harnesses, `catalog.sqlite`, one `agent.sqlite` per session, shared App State |
| `apps/dpi-sdk` | inside everything | the v1 wire contract, `DpiClient`, SSE reader, `AgentModel` / `SessionModel` reducers |
| `apps/dpi-playground` | your laptop `127.0.0.1:4781` | device registry, token-injecting proxy, multiplexed SSE, Vue client |
| `apps/dpi-tui` | any terminal | nothing: it reads a device URL and token and talks to the device directly |

## Quickstart

Prereqs: Node 24, `just`, `zsh`, and an API key (DeepSeek by default; OpenRouter optional).

```bash
cp .env.example .env                          # set DEEPSEEK_API_KEY
cp dpi-network.example.yaml dpi-network.yaml  # starts with only `local`

just install                                  # npm install for the four apps
just check                                    # types and unit tests, free and offline

just net up local                             # write ~/.dpi/backend.env with a token
just backend run                              # :4780
just hub build && just hub start              # :4781 (second terminal)
just tui attach local                         # or attach from the terminal (third terminal)
```

Set `DPI_PROVIDER: faux` in `dpi-network.yaml` to run the deterministic offline model instead of a real one.

## Commands

```bash
just                       # groups: net, backend, hub, tui, test
just check                 # type checks and unit tests, every app
just backend run           # this machine's device server on :4780
just hub start             # web UI on :4781
just tui attach <device>[:<session>[:<agent>]]
just net up <id>           # bring a device online (idempotent)
just net status            # probe every device
just test ui               # web suite against two faux devices
just test device <id>      # real-model suites on one device
just test e2e <id>         # TUI + web + restart mid-tool + fork
```

Devices are data: `dpi-network.yaml` declares each one by kind (`local`, `ssh`, `exe-dev`, `url`). No code or recipe names a machine, and tokens never live in the YAML.

## Guarantees and boundaries

- Closing a client never stops work. A backend restart resumes unfinished tasks from their checkpoints. Replay-safe tools rerun; unsafe ones return an interrupted result.
- A token holder has the agent's shell and filesystem access on that device. Start dirs are where sessions begin, not a sandbox.
- `dpi-backend` binds `127.0.0.1` unless told otherwise.
- `pi-durable` is experimental: every minor version may break the API. Versions are pinned exactly and `package-lock.json` is committed.

## License

MIT. See `LICENSE` and `NOTICE`.
