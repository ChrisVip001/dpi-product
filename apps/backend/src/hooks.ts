// Inbound hooks: a scoped, signed trigger so a bridge (Feishu, DingTalk, a task board, CI) can hand one
// requirement to one agent without holding the device token.
//
//   POST /v1/hooks/:name                     { text, chat?, user?, waitMs? }  → 202 queued, or 200 when waited
//   GET  /v1/hooks/:name/submissions/:id     ?waitMs=                        → the same SendResult /messages gives
//   GET  /v1/hooks/:name/approvals                                           → job runs waiting for a person
//   POST /v1/hooks/:name/approvals/:taskId   { approved }                    → approve or decline one run
//
// Callers sign every request with the hook's own secret, so a leaked group token can be revoked on its own and
// a replay cannot start a second run: `event_id` is the idempotency key.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { JOB_RUNS_DOC, type JobRunsDoc } from "../../sdk/src/jobs.js";
import type { SendResult, WhenBusy } from "../../sdk/src/api.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import type { Store } from "./store.js";

export interface HookSpec {
  /** ≥32 chars. Signs every request to this hook; rotate by editing the file and restarting. */
  secret: string;
  /** Session id or unique name the hook writes into. */
  session: string;
  /** Agent id, `main` or a unique name. Defaults to `main`. */
  agent?: string;
  /** Optional wrapper around the text: `来自飞书群 {{chat}} 的需求：\n{{text}}`. */
  prompt?: string;
  /** What to do when the agent is mid-turn. Defaults to `followUp`. */
  whenBusy?: WhenBusy;
  /** Deliveries per minute for this hook. Defaults to 20; a retry of a known event is free. */
  limit?: number;
}

export type Hooks = Record<string, HookSpec>;
export type Hooked = { name: string; hook: HookSpec };

const MAX_TEXT = 100_000;
const MAX_WAIT_MS = 300_000;
const MAX_SKEW_MS = 300_000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BUSY: WhenBusy[] = ["followUp", "steer", "reject"];

const rawBody = (req: Request) =>
  Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody) ? (req as Request & { rawBody: Buffer }).rawBody : Buffer.alloc(0);

/** The file hooks are declared in: `$DPI_HOOKS_FILE`, else `~/.dpi/hooks.json`. Missing means no hooks. */
export function loadHooks(file: string): Hooks {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error(`${file} must be an object of hooks`);
  const hooks: Hooks = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NAME.test(name)) throw Error(`${file}: hook name "${name}" must be lowercase letters, digits, - or _ (≤32)`);
    const spec = value as Partial<HookSpec> | undefined;
    if (!spec || typeof spec !== "object") throw Error(`${file}: hook "${name}" must be an object`);
    if (typeof spec.secret !== "string" || spec.secret.length < 32)
      throw Error(`${file}: hook "${name}" needs a secret of at least 32 characters`);
    if (typeof spec.session !== "string" || !spec.session.trim())
      throw Error(`${file}: hook "${name}" needs a session`);
    if (spec.agent !== undefined && (typeof spec.agent !== "string" || !spec.agent.trim()))
      throw Error(`${file}: hook "${name}" agent must be a string`);
    if (spec.prompt !== undefined && typeof spec.prompt !== "string")
      throw Error(`${file}: hook "${name}" prompt must be a string`);
    if (spec.whenBusy !== undefined && !BUSY.includes(spec.whenBusy))
      throw Error(`${file}: hook "${name}" whenBusy must be one of ${BUSY.join(", ")}`);
    if (spec.limit !== undefined && (!Number.isSafeInteger(spec.limit) || spec.limit < 1 || spec.limit > 600))
      throw Error(`${file}: hook "${name}" limit must be a whole number of deliveries per minute (1–600)`);
    hooks[name] = { ...spec, secret: spec.secret, session: spec.session.trim() } as HookSpec;
  }
  return hooks;
}

/** `sha256=<hex>` over `timestamp\nMETHOD\nurl\nsha256(body)`. Deterministic, so the bridge signs the same way. */
export function signHook(secret: string, timestamp: string, method: string, url: string, raw: Buffer | string = "") {
  const body = createHash("sha256").update(raw).digest("hex");
  return createHmac("sha256", secret).update(`${timestamp}\n${method.toUpperCase()}\n${url}\n${body}`).digest("hex");
}

/** Throws `unauthorized` unless the request carries a fresh, well-signed timestamp for this hook. */
export function verifyHook(name: string, hook: HookSpec, req: Request, now = Date.now()) {
  const timestamp = (req.get("x-dpi-hook-timestamp") ?? "").trim();
  const presented = (req.get("x-dpi-hook-signature") ?? "").trim().replace(/^sha256=/, "");
  if (!timestamp || !presented)
    throw new ApiFault("unauthorized", `Hook "${name}" needs x-dpi-hook-timestamp and x-dpi-hook-signature`);
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > MAX_SKEW_MS)
    throw new ApiFault("unauthorized", `Hook "${name}" timestamp is stale or not in seconds`);
  const expected = signHook(hook.secret, timestamp, req.method, req.originalUrl, rawBody(req));
  const a = Buffer.from(presented, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new ApiFault("unauthorized", `Hook "${name}" signature does not match`);
}

/** `{{text}}`, `{{chat}}`, `{{user}}`, `{{source}}`, `{{event}}` and `{{hook}}`; unknown names stay as written. */
export function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}

const waitOf = (value: unknown) => {
  const n = Number(value ?? 0) || 0;
  return Math.min(Math.max(n, 0), MAX_WAIT_MS);
};

function abortOnClose(res: Response) {
  const closed = new AbortController();
  res.on("close", () => closed.abort());
  return closed.signal;
}

const DEFAULT_LIMIT = 20;

export function hooksRouter(store: Store, hooks: Hooks) {
  const r = Router();
  // A chat group is a noisy place: one slow agent plus a stuck loop would queue forever. A fixed window per
  // hook keeps the promise small; retries of a known event never reach this counter.
  const windows = new Map<string, { used: number; resetAt: number }>();

  const specOf = (req: Request): Hooked => {
    const name = String(req.params.name);
    const hook = hooks[name];
    if (!hook) throw notFound(`No hook "${name}" on this device`);
    return { name, hook };
  };

  /** Seconds to wait when this delivery is over the limit, or undefined when it may proceed. */
  const overLimit = (name: string, hook: HookSpec, now = Date.now()) => {
    const limit = hook.limit ?? DEFAULT_LIMIT;
    const window = windows.get(name);
    if (!window || window.resetAt <= now) {
      windows.set(name, { used: 1, resetAt: now + 60_000 });
      return undefined;
    }
    if (window.used >= limit) return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    window.used += 1;
    return undefined;
  };

  const post: RequestHandler = (req, res, next) => {
    const run = async () => {
      const { name, hook } = specOf(req);
      verifyHook(name, hook, req);
      const event = (req.get("x-dpi-event") ?? "").trim();
      if (!event) throw invalid("x-dpi-event is required: it is the idempotency key for the delivery");
      if (event.length > 128) throw invalid("x-dpi-event is longer than 128 characters");

      const key = `hook:${name}:${event}`;
      const routeId = `POST /v1/hooks/${name}`;
      const replay = store.replay(key, routeId);
      if (replay) return void res.status(200).set("Idempotent-Replay", "true").json(replay.body);

      const retryIn = overLimit(name, hook);
      if (retryIn !== undefined)
        return void res
          .status(429)
          .set("Retry-After", String(retryIn))
          .json({
            error: {
              code: "busy",
              message: `Hook "${name}" is limited to ${hook.limit ?? DEFAULT_LIMIT} deliveries per minute`,
            },
          });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw invalid("Body needs text");
      if (text.length > MAX_TEXT) throw invalid("text is longer than 100,000 characters");
      const whenBusy = (body.whenBusy ?? hook.whenBusy ?? "followUp") as WhenBusy;
      if (!BUSY.includes(whenBusy)) throw invalid(`whenBusy must be one of ${BUSY.join(", ")}`);

      const content = hook.prompt
        ? renderPrompt(hook.prompt, {
            text,
            chat: typeof body.chat === "string" ? body.chat : "",
            user: typeof body.user === "string" ? body.user : "",
            source: typeof body.source === "string" ? body.source : name,
            event,
            hook: name,
          })
        : text;

      const { h, c } = await store.resolveAgent(hook.session, hook.agent ?? "main");
      const submission = await store.send(c, { content, whenBusy, requestId: key });
      const waitMs = waitOf(body.waitMs);
      if (waitMs > 0) {
        const result = await store.settled(h, submission.id, waitMs, abortOnClose(res));
        store.remember(key, routeId, 200, result);
        return void res.status(200).json(result);
      }
      const payload = {
        submissionId: submission.id,
        session: hook.session,
        agent: hook.agent ?? "main",
        status: "queued" as const,
      };
      store.remember(key, routeId, 202, payload);
      res.status(202).json(payload);
    };
    run().catch(next);
  };

  const get: RequestHandler = (req, res, next) => {
    const run = async () => {
      const { name, hook } = specOf(req);
      verifyHook(name, hook, req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw invalid("Submission id must be a positive integer");
      const { h } = await store.resolveAgent(hook.session, hook.agent ?? "main");
      const result: SendResult = await store.settled(h, id, waitOf(req.query.waitMs), abortOnClose(res));
      res.json(result);
    };
    run().catch(next);
  };

  /** Job runs in this hook's session that are waiting for a person, so a bridge can ask in chat. */
  const approvals: RequestHandler = (req, res, next) => {
    const run = async () => {
      const { name, hook } = specOf(req);
      verifyHook(name, hook, req);
      const { h, c } = await store.resolveAgent(hook.session, hook.agent ?? "main");
      const doc = (await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc;
      const items = Object.values(doc.items ?? {})
        .filter((job) => job.approval === "pending")
        .map((job) => ({
          taskId: job.id,
          job: job.job,
          title: job.title,
          run: job.run,
          phase: job.phase,
          since: job.updatedAt,
        }));
      res.json({ items });
    };
    run().catch(next);
  };

  const decide: RequestHandler = (req, res, next) => {
    const run = async () => {
      const { name, hook } = specOf(req);
      verifyHook(name, hook, req);
      const taskId = Number(req.params.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw invalid("taskId must be a positive integer");
      const approved = (req.body ?? {}).approved;
      const { c } = await store.resolveAgent(hook.session, hook.agent ?? "main");
      const result = await store.approveJob(c, taskId, approved);
      res.json({ ...result, taskId, approved });
    };
    run().catch(next);
  };

  r.post("/:name", post);
  r.get("/:name/submissions/:id", get);
  r.get("/:name/approvals", approvals);
  r.post("/:name/approvals/:taskId", decide);
  return r;
}

/** Keeps the raw body of a JSON request so the signature can be checked byte for byte. */
export const keepRawBody = (req: Request, _res: Response, buf: Buffer) => {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
};
