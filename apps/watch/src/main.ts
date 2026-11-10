// watch: desktop notifications for one device, so nobody has to keep a tab open.
//   watch <device>                       device id from ~/.dpi/network.sqlite (or DPI_DEVICE)
//   watch --url <url> --token <token>    any backend directly (or DPI_URL + DPI_TOKEN)
//   --notify osascript | stdout | webhook:<url>    (default: osascript on macOS, stdout elsewhere)
//
// It follows the device stream (activity, tree) and one session stream per open session, and reports
// only what needs a person: a finished turn with its preview, a task waiting for approval or input,
// and the device going away. Everything else stays silent.
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { DpiClient } from "../../sdk/src/client.ts";
import { NetworkRegistry } from "../../sdk/src/node/registry.ts";
import { syncConfigToRegistry, tryLoadNetworkConfig } from "../../sdk/src/node/config.ts";
import { t } from "./i18n.ts";
import type { Notice } from "./watcher.ts";
import { Watcher } from "./watcher.ts";

const USAGE = t("watch.usage");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    notify: { type: "string" },
    verbose: { type: "boolean", short: "v" },
    once: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const registry = new NetworkRegistry();
const config = tryLoadNetworkConfig(process.env.INIT_CWD ?? process.cwd());
if (config) syncConfigToRegistry(config, registry);

const directUrl = values.url ?? process.env.DPI_URL;
let url: string;
let token: string;
if (directUrl) {
  url = directUrl.replace(/\/+$/, "");
  token = values.token ?? process.env.DPI_TOKEN ?? "";
  if (!token) {
    process.stderr.write(`${t("watch.needToken")}\n`);
    process.exit(1);
  }
} else {
  const id = positionals[0] ?? process.env.DPI_DEVICE ?? "";
  const known = id ? registry.get(id) : registry.list()[0];
  if (!known) {
    process.stderr.write(`${id ? t("watch.unknownDevice", { id }) : t("watch.emptyRegistry")}\n`);
    process.exit(1);
  }
  if (!known.token) {
    process.stderr.write(`${t("watch.noToken", { id: known.id })}\n`);
    process.exit(1);
  }
  url = known.url;
  token = known.token;
  process.stdout.write(`${t("watch.watching", { id: known.id, url })}\n`);
}

// ---------------------------------------------------------------- notifiers

const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function notifier(how: string) {
  if (how === "stdout") return (n: Notice) => process.stdout.write(`${n.title} — ${n.body}\n`);
  if (how.startsWith("webhook:")) {
    const target = how.slice("webhook:".length);
    return (n: Notice) => {
      void fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(n),
      }).catch((e: unknown) =>
        process.stderr.write(`${t("watch.webhookFailed", { message: e instanceof Error ? e.message : String(e) })}\n`),
      );
    };
  }
  return (n: Notice) => {
    execFile("osascript", ["-e", `display notification "${escape(n.body)}" with title "${escape(n.title)}"`], () => {});
  };
}

const how = values.notify ?? (process.platform === "darwin" ? "osascript" : "stdout");
const print = notifier(how);
const watcher = new Watcher((notice) => {
  process.stdout.write(`[${new Date(notice.at).toLocaleTimeString()}] ${notice.title}\n`);
  print(notice);
  if (values.once) shutdown(0);
});

// ---------------------------------------------------------------- streams

const client = new DpiClient(url, token);
const clients = new Map<string, AbortController>();
const stop = new AbortController();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shutdown(code: number) {
  stop.abort();
  for (const controller of clients.values()) controller.abort();
  setTimeout(() => process.exit(code), 50);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** One session stream per session the tree reports; task states feed the "needs you" notices. */
function follow(sessionId: string, name: string) {
  if (clients.has(sessionId)) return;
  const controller = new AbortController();
  clients.set(sessionId, controller);
  stop.signal.addEventListener("abort", () => controller.abort(), { once: true });
  void (async () => {
    try {
      for await (const frame of client.session(sessionId).events(controller.signal)) {
        if (frame.type === "session") watcher.tasks(sessionId, frame.tasks);
        else if (frame.type === "tasks") watcher.tasks(sessionId, frame.tasks);
      }
    } catch {
      // A closed session stream is not an incident: the tree drops it and the device stream stays up.
    } finally {
      clients.delete(sessionId);
      void name;
    }
  })();
}

async function deviceLoop() {
  while (!stop.signal.aborted) {
    try {
      for await (const frame of client.deviceEvents(stop.signal)) {
        if (stop.signal.aborted) return;
        watcher.connection(true);
        if (frame.type === "activity") {
          if (values.verbose) for (const item of frame.items) process.stdout.write(`· ${item.type} ${item.agentId}\n`);
          watcher.activity(frame.items);
        } else if (frame.type === "tree") {
          watcher.tree(frame.tree);
          for (const session of frame.tree.sessions) follow(session.id, session.name);
        } else if (frame.type === "fault") {
          process.stderr.write(`${t("watch.fault", { message: frame.error.message })}\n`);
        }
      }
    } catch (e) {
      if (stop.signal.aborted) return;
      watcher.connection(false);
      process.stderr.write(`${t("watch.streamEnded", { message: e instanceof Error ? e.message : String(e) })}\n`);
    }
    if (stop.signal.aborted) return;
    await sleep(3000);
  }
}

void deviceLoop();
