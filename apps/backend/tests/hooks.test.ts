import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHooks, renderPrompt, signHook } from "../src/hooks.js";
import { DpiClient } from "../../sdk/src/client.js";
import type { JobRunsDoc } from "../../sdk/src/jobs.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const secret = randomBytes(32).toString("hex");
const tightSecret = randomBytes(32).toString("hex");

type Call = { name?: string; event?: string; secret?: string; timestamp?: number; sign?: boolean };

function deliver(base: string, body: Record<string, unknown>, opts: Call = {}) {
  const name = opts.name ?? "feishu";
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  const url = `/v1/hooks/${name}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-dpi-event": opts.event ?? `evt-${randomBytes(4).toString("hex")}`,
    "x-dpi-hook-timestamp": timestamp,
  };
  if (opts.sign !== false)
    headers["x-dpi-hook-signature"] = `sha256=${signHook(opts.secret ?? secret, timestamp, "POST", url, raw)}`;
  return fetch(base + url, { method: "POST", headers, body: raw });
}

function signed(base: string, method: "GET" | "POST", path: string, body?: unknown, key = secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {
    "x-dpi-hook-timestamp": timestamp,
    "x-dpi-hook-signature": `sha256=${signHook(key, timestamp, method, path, raw)}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : raw });
}

function read(base: string, name: string, id: number, waitMs: number, opts: { secret?: string; sign?: boolean } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = `/v1/hooks/${name}/submissions/${id}?waitMs=${waitMs}`;
  const headers: Record<string, string> = { "x-dpi-hook-timestamp": timestamp };
  if (opts.sign !== false)
    headers["x-dpi-hook-signature"] = `sha256=${signHook(opts.secret ?? secret, timestamp, "GET", url, "")}`;
  return fetch(base + url, { headers });
}

test("a signed hook delivers a requirement, dedupes retries and reads the answer back", async () => {
  const t = await tempStore();
  const hooksFile = join(t.root, "hooks.json");
  await writeFile(
    hooksFile,
    JSON.stringify({
      feishu: {
        secret,
        session: "hookbox",
        agent: "main",
        prompt: "来自飞书群 {{chat}}（{{user}}）的需求：\n{{text}}",
      },
      tight: { secret: tightSecret, session: "hookbox", limit: 2 },
    }),
  );
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    env: { DPI_HOOKS_FILE: hooksFile },
  });
  try {
    const client = new DpiClient(server.base, token);
    await client.createSession({ name: "hookbox", cwd: t.work, model: faux });

    // Unknown hook, unsigned call, wrong secret and a stale timestamp all fail closed.
    assert.equal((await deliver(server.base, { text: "x" }, { name: "nope" })).status, 404);
    assert.equal((await deliver(server.base, { text: "x" }, { sign: false })).status, 401);
    assert.equal((await deliver(server.base, { text: "x" }, { secret: "y".repeat(32) })).status, 401);
    assert.equal(
      (await deliver(server.base, { text: "x" }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status,
      401,
    );
    assert.equal((await deliver(server.base, {})).status, 400);

    // A queued delivery returns the submission; the answer is read back with the same secret.
    const queued = await deliver(server.base, { text: "帮我改个 bug", chat: "oc_42", user: "ou_7" });
    assert.equal(queued.status, 202);
    const { submissionId } = (await queued.json()) as { submissionId: number };
    const answer = await read(server.base, "feishu", submissionId, 10_000);
    assert.equal(answer.status, 200);
    const settled = (await answer.json()) as { status: string; answer?: { text: string } };
    assert.equal(settled.status, "done");
    assert.equal(settled.answer?.text, "Echo: 来自飞书群 oc_42（ou_7）的需求：\n帮我改个 bug");

    // The same event id is one run: a platform retry replays the stored response.
    const event = "evt-retry-1";
    const first = await deliver(server.base, { text: "第一次", waitMs: 10_000 }, { event, name: "feishu" });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { submissionId: number; status: string };
    assert.equal(firstBody.status, "done");
    const retry = await deliver(server.base, { text: "第一次", waitMs: 10_000 }, { event });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("idempotent-replay"), "true");
    assert.equal(((await retry.json()) as { submissionId: number }).submissionId, firstBody.submissionId);

    // Reading a submission needs the hook's signature too.
    assert.equal((await read(server.base, "feishu", firstBody.submissionId, 1000, { sign: false })).status, 401);

    // A noisy chat hits the per-minute cap, and a retry of an accepted event is free.
    const tight = { name: "tight", secret: tightSecret };
    assert.equal((await deliver(server.base, { text: "一" }, { ...tight, event: "t1" })).status, 202);
    assert.equal((await deliver(server.base, { text: "二" }, { ...tight, event: "t2" })).status, 202);
    const limited = await deliver(server.base, { text: "三" }, { ...tight, event: "t3" });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await deliver(server.base, { text: "一" }, { ...tight, event: "t1" })).status, 200);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a hook can list and decide a job approval waiting in its session", async () => {
  const t = await tempStore();
  const hooksFile = join(t.root, "hooks.json");
  await writeFile(hooksFile, JSON.stringify({ feishu: { secret, session: "hookbox" } }));
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    env: { DPI_HOOKS_FILE: hooksFile },
  });
  try {
    const client = new DpiClient(server.base, token);
    await client.createSession({ name: "hookbox", cwd: t.work, model: faux });
    const agent = client.agent("hookbox", "main");
    await agent.demo("jobs", { job: "release-check", input: { commits: 1 } });

    const runs = async () => (await agent.doc<JobRunsDoc>("demo.job-runs")).value;
    await until(
      async () => Object.values((await runs()).items).some((run) => run.approval === "pending"),
      30_000,
      "a pending approval",
    );
    const pending = Object.values((await runs()).items).find((run) => run.approval === "pending")!;

    const listed = await signed(server.base, "GET", "/v1/hooks/feishu/approvals");
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { items: { taskId: number; job: string; title: string }[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].taskId, pending.id);
    assert.equal(body.items[0].job, "release-check");

    // The decision must be explicit, and it lands on the run.
    const missing = await signed(server.base, "POST", `/v1/hooks/feishu/approvals/${pending.id}`, {});
    assert.equal(missing.status, 400);
    const ok = await signed(server.base, "POST", `/v1/hooks/feishu/approvals/${pending.id}`, { approved: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, taskId: pending.id, approved: true });
    await until(
      async () => (await runs()).items[String(pending.id)]?.approval === "approved",
      10_000,
      "the approval to apply",
    );

    // Deciding twice is a conflict, not a second decision.
    const again = await signed(server.base, "POST", `/v1/hooks/feishu/approvals/${pending.id}`, { approved: false });
    assert.equal(again.status, 409);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("hook config and templates fail fast with a readable message", async () => {
  const t = await tempStore();
  const file = join(t.root, "hooks.json");
  try {
    await writeFile(file, "{");
    assert.throws(() => loadHooks(file), /not valid JSON/);
    await writeFile(file, JSON.stringify({ "Bad Name": { secret: "x".repeat(40), session: "s" } }));
    assert.throws(() => loadHooks(file), /hook name/);
    await writeFile(file, JSON.stringify({ feishu: { secret: "short", session: "s" } }));
    assert.throws(() => loadHooks(file), /at least 32 characters/);
    await writeFile(file, JSON.stringify({ feishu: { secret: "x".repeat(40) } }));
    assert.throws(() => loadHooks(file), /needs a session/);
    await writeFile(file, JSON.stringify({ feishu: { secret: "x".repeat(40), session: "s", whenBusy: "later" } }));
    assert.throws(() => loadHooks(file), /whenBusy/);
    await writeFile(file, JSON.stringify({ feishu: { secret: "x".repeat(40), session: "s" } }));
    assert.deepEqual(Object.keys(loadHooks(file)), ["feishu"]);
    assert.equal(loadHooks(join(t.root, "missing.json")).feishu, undefined);

    assert.equal(renderPrompt("[{{chat}}] {{text}} {{unknown}}", { chat: "c", text: "t" }), "[c] t {{unknown}}");
  } finally {
    await t.cleanup();
  }
});
