// Server-Sent Event streams. Three scopes share one frame envelope (see sdk/src/api.ts):
// device (tree + activity), session (agents, tasks, usage) and agent (pi-durable agent events).
// Streams are viewers only: closing one never aborts work or closes a harness.
import type { Request, Response } from "express";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Activity, DeviceTree, Frame, StreamScope } from "../../sdk/src/api.js";
import { ViewDiffer } from "./view-wire.js";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS, type SessionRow, type Store } from "./store.js";
import { invalid } from "./errors.js";

const MAX_BUFFER = 2_000_000;

export interface Sse {
  send(frame: Frame): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
  sendIfChanged(key: string, frame: Frame): void;
}

export function openSse(res: Response, scope: StreamScope): Sse {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  let seq = 0;
  let closed = false;
  const cleanups: Array<() => void> = [];
  const last = new Map<string, string>();
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
  };
  res.on("close", close);
  const send = (frame: Frame) => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER) {
      // A slow viewer reconnects to a fresh snapshot instead of buffering without bound.
      res.end();
      close();
      return;
    }
    res.write(`id: ${++seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  send({ type: "hello", apiVersion: 1, serverTime: Date.now(), scope });
  return {
    send,
    get closed() {
      return closed;
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    sendIfChanged(key, frame) {
      const json = JSON.stringify(frame);
      if (last.get(key) === json) return;
      last.set(key, json);
      send(frame);
    },
  };
}

/** Run `fn` at most once per `ms`, never concurrently, always catching up on the latest trigger. */
export function coalesce(fn: () => Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const run = async () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error("[backend] stream update failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
      if (again) {
        again = false;
        trigger();
      }
    }
  };
  const trigger = () => {
    if (!timer) timer = setTimeout(() => void run(), ms);
  };
  return Object.assign(trigger, { now: run, cancel: () => timer && clearTimeout(timer) });
}

export function parseDocs(raw: unknown, allowed: readonly string[]): string[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string") throw invalid("docs must be a comma-separated list");
  const kinds = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  for (const kind of kinds)
    if (!allowed.includes(kind)) throw invalid(`Unknown document ${kind}. Allowed: ${allowed.join(", ")}`);
  return kinds;
}

export function diffActivity(prev: DeviceTree | undefined, next: DeviceTree): Activity[] {
  if (!prev) return [];
  const before = new Map(prev.sessions.flatMap((s) => s.agents.map((a) => [`${s.id}/${a.id}`, a.busy] as const)));
  return next.sessions.flatMap((s) =>
    s.agents.flatMap((a): Activity[] => {
      const was = before.get(`${s.id}/${a.id}`) ?? false;
      if (was === a.busy) return [];
      return [{ type: a.busy ? "agent.started" : "agent.finished", sessionId: s.id, agentId: a.id, at: next.at }];
    }),
  );
}

// ---------------------------------------------------------------- device scope

export function deviceStream(store: Store, req: Request, res: Response) {
  const docs = parseDocs(req.query.docs, DEVICE_DOC_KINDS);
  const sse = openSse(res, { kind: "device" });
  let previous: DeviceTree | undefined;
  const push = coalesce(async () => {
    if (sse.closed) return;
    const tree = await store.tree();
    const { at: _at, ...stable } = tree;
    const items = diffActivity(previous, tree);
    previous = tree;
    sse.sendIfChanged("tree", { type: "tree", tree: { ...stable, at: 0 } });
    if (items.length) {
      for (const item of items)
        if (item.type === "agent.finished") {
          const row = store.list().find((r) => r.id === item.sessionId);
          if (row) item.preview = await store.preview(row, item.agentId).catch(() => undefined);
        }
      sse.send({ type: "activity", items });
    }
    for (const kind of docs) {
      const doc = await store.deviceDoc(kind);
      sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: doc.value, revision: doc.revision });
    }
  }, 250);
  sse.onClose(store.subscribe(push));
  sse.onClose(() => push.cancel());
  void push.now();
}

// ---------------------------------------------------------------- session scope

export async function sessionStream(store: Store, row: SessionRow, res: Response) {
  const h = store.harness(row);
  const sse = openSse(res, { kind: "session", sessionId: row.id });
  const watch = await h.watchTaskGraph(ctx);
  const tasksOf = (value: { tasks: Readonly<Record<string, unknown>> }) =>
    Object.values(value.tasks).map((t) => store.taskNode(t));
  let tasks = await store.labelTasks(h, tasksOf(watch.value));
  sse.send({ type: "session", agents: await store.agents(row, tasks), tasks, usage: await store.usage(h) });
  watch.start(async (call) => {
    if (sse.closed || call.kind !== "value") return;
    tasks = await store.labelTasks(h, tasksOf(call.value));
    sse.sendIfChanged("tasks", { type: "tasks", tasks });
    push();
  });
  const push = coalesce(async () => {
    if (sse.closed || !store.opened.has(row.id)) return;
    sse.sendIfChanged("agents", { type: "agents", agents: await store.agents(row, tasks) });
    sse.sendIfChanged("usage", { type: "usage", usage: await store.usage(h) });
  }, 250);
  // The store notifies on every commit (Session.observeCommits) and on catalog changes, so agents
  // and usage are pushed as soon as the device sees them.
  const offCatalog = store.subscribe(() => push());
  sse.onClose(() => {
    offCatalog();
    push.cancel();
    void watch.stop();
  });
}

// ---------------------------------------------------------------- agent scope

export async function agentStream(
  store: Store,
  target: { row: SessionRow; h: Harness; c: Conversation },
  req: Request,
  res: Response,
) {
  const { row, h, c } = target;
  const docs = parseDocs(req.query.docs, AGENT_DOC_KINDS);
  // 1.5: the conversation view replaces the old event stream. The window keeps the newest 50 entries and
  // grows to 200 before it splices down; a splice makes the next frame a fresh snapshot.
  const watch = await c.watch(ctx, { min: 50, max: 200 });
  const sse = openSse(res, { kind: "agent", sessionId: row.id, agentId: c.id as number });
  const differ = new ViewDiffer();
  const first = differ.next(watch.value);
  sse.send({
    type: "snapshot",
    snapshot: first && "full" in first ? first.full : (undefined as never),
    inbox: await store.inbox(h, c),
  });
  const push = coalesce(async () => {
    if (sse.closed) return;
    const next = differ.next(watch.value);
    if (!next) return;
    if ("full" in next) sse.send({ type: "snapshot", snapshot: next.full, inbox: await store.inbox(h, c) });
    else sse.send({ type: "view", view: next.update });
  }, 100);
  const pushInbox = coalesce(async () => {
    if (!sse.closed) sse.send({ type: "inbox", items: await store.inbox(h, c) });
  }, 250);
  const pushDocs = coalesce(async () => {
    for (const kind of docs)
      sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: await store.agentDoc(h, c, kind) });
  }, 500);
  await pushDocs.now();
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    push();
    pushInbox();
    if (docs.length) pushDocs();
  });
  // Custom documents can be task-scoped, so they do not always publish the conversation view:
  // every commit (Session.observeCommits in the store) nudges them instead.
  const offDocs = docs.length ? store.subscribe(() => pushDocs()) : () => {};
  sse.onClose(() => {
    offDocs();
    push.cancel();
    pushInbox.cancel();
    pushDocs.cancel();
    void watch.stop();
  });
}
