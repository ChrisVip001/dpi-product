import type { SharedState } from "./shared-state.js";
import { arr, bool, int, map, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { isAbsolute, resolve } from "node:path";
import { readState, type AppState } from "../../sdk/src/app-state.js";
import type { SessionSummary, ThinkingLevel } from "../../sdk/src/api.js";
import { THINKING_LEVELS } from "../../sdk/src/api.js";
import type { WireEntry, WireMessage } from "../../sdk/src/api.js";
import { messageText } from "../../sdk/src/transcript.js";
import { jobRunDone, type JobRun } from "../../sdk/src/jobs.js";
import {
  defineDoc,
  defineTool,
  defineExtension,
  section,
  configure,
  AssistantEntry,
  type EntryRecord,
  type JsonObject,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { JobRuns, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { searchHistory } from "./history.js";
import { classed, isReadName } from "./tool-meta.js";

export const Workspace = defineDoc<AppState>({
  kind: "demo.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
  checkpointWhen: () => false,
});
const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: () => false,
});
/** ping_on_call_engineer pages once per agent; this records the page. */
const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
  checkpointWhen: () => false,
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;

/**
 * One run's structured result, the shape programs get from `run_durable_job` and `check_durable_job` without parsing the
 * text meant for the model. Same fields as the run record, plus a `missing` status for a run with no record.
 */
const JOB_RUN_SHAPE = {
  type: "object",
  properties: {
    taskId: { type: "number", description: "The run's durable task id." },
    job: { type: "string", description: "The job id." },
    status: {
      type: "string",
      enum: ["pending", "running", "waiting", "completed", "failed", "aborted", "declined", "missing"],
    },
    run: { type: ["number", "null"], description: "The nth run of this job in this conversation." },
    phase: { type: ["string", "null"], description: "The phase the run is in, or ended in." },
    approval: { type: ["string", "null"], description: "pending, approved, declined or cancelled." },
    result: { type: ["string", "null"], description: "The run's saved result, when it completed." },
    error: { type: ["string", "null"], description: "Why the run failed, when it did." },
  },
  required: ["taskId", "job", "status"],
  additionalProperties: false,
} as const;

const JOB_RESULT_SCHEMA = JOB_RUN_SHAPE;
/** `check_durable_job` answers with the runs it matched: one for a task id or a job, all of them for a bare list. */
const JOB_RUNS_SCHEMA = {
  type: "object",
  properties: { runs: { type: "array", items: JOB_RUN_SHAPE } },
  required: ["runs"],
  additionalProperties: false,
} as const;

/** What `subagent` hands to programs: the child conversation, how its turn ended, and its answer text. */
const SUBAGENT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    conversationId: { type: "number", description: "The child conversation that did the work." },
    status: { type: "string", description: "How the child's turn ended: done, failed, aborted or interrupted." },
    answer: { type: ["string", "null"], description: "The child's final answer, as text." },
  },
  required: ["conversationId", "status"],
  additionalProperties: false,
} as const;

const jobStructured = (run: JobRun) => ({
  taskId: run.id,
  job: run.job,
  status: run.status,
  run: run.run,
  phase: run.phase ?? null,
  approval: run.approval ?? null,
  result: run.result ?? null,
  error: run.error ?? null,
});

/** A JSON value, for the nested results `gather` passes on without interpreting them. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What `gather` hands to programs: one entry per nested call, in the order asked. */
const GATHER_RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          ok: { type: "boolean" },
          value: {},
          diagnostics: { type: "array", items: { type: "string" } },
        },
        required: ["tool", "ok"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** A light subtask: several read-only calls in one step, no child conversation, no new context. */
const MAX_GATHER_CALLS = 8;

/** `deferred` when the device keeps rare tools behind `tool_search`; empty otherwise, so the tool is always offered. */
const deferredWhen = (on: boolean | undefined) => (on ? ({ deferred: true } as const) : {});

export function createPlayground(
  shared: SharedState,
  sessionId: string,
  spawn: SpawnSession,
  jobs: Jobs,
  options: { deferred?: boolean } = {},
) {
  const readAppState = defineTool({
    name: "read_state",
    description:
      "Read the shared App State object used by every session, conversation and fork, or a field at a JSON Pointer path. Empty path reads the whole object.",
    parameters: obj({ path: opt(str()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        output: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description:
      'CRUD the same shared App State for every agent and fork in this product. create adds a new field, update replaces an existing value, delete removes it, increment adds a signed number. value_json must be JSON-encoded text: 3 for a number, true for a boolean, "hello" (including quotes) for a string, {"enabled":true} for an object, or [1,2] for an array. Omit value_json for delete. Use JSON Pointer paths: /counter, /settings/enabled, /notes/- to append. Escape ~ as ~0 and / as ~1. Empty path with update replaces the whole root object, with delete clears it. Read first with read_state. UI controls update live. Changes are atomic and replay-safe.',
    parameters: obj({
      operation: oneOf(["create", "update", "delete", "increment"]),
      path: str(),
      value_json: opt(
        str({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { output: [{ type: "text", text: value }] };
    },
  });
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description:
      "List the durable jobs you can start with run_durable_job: each job's id, what it does, its named phases, the inputs it takes (type, default, limits), whether it waits for a person's approval, the App State path where every run saves its result, and its recent runs in this conversation with their task ids for check_durable_job.",
    parameters: obj({}),
    replay: "safe",
    ...deferredWhen(options.deferred),
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description:
      'Start a durable job: a repeatable workflow with named phases that runs as one checkpointed task and shows live in the chat. Call list_durable_jobs first for ids and inputs. It runs in the background: you get its task id at once, the conversation owns the run, and you check it with check_durable_job. Set wait true only when the user wants you to wait for the result; then the call owns the run, an interrupt stops it, and you get the outcome of every phase. Example: {"job":"workspace-snapshot","input":{"path":"."}}.',
    parameters: obj({
      job: str({ description: "Job id from list_durable_jobs." }),
      input: opt(
        map(union([str(), num()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: opt(
        bool({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    structuredOutputSchema: JOB_RESULT_SCHEMA,
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          output: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          structuredOutput: run
            ? jobStructured(run)
            : { taskId, job: def.id, status: "pending", run: null, phase: null, approval: null, result: null, error: null },
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        output: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        structuredOutput: run
          ? jobStructured(run)
          : { taskId, job: def.id, status: "missing", run: null, phase: null, approval: null, result: null, error: null },
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description:
      "Check durable job runs in this conversation. With task_id, one run in full: status, current phase, every phase's outcome and steps (commands, the subagent's tool calls, App State writes), approval, result or error. With job, that job's latest run. With neither, a short list of recent runs. Task ids come from run_durable_job and list_durable_jobs.",
    parameters: obj({
      task_id: opt(int({ minimum: 1, description: "The run's task id." })),
      job: opt(str({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    structuredOutputSchema: JOB_RUNS_SCHEMA,
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
          structuredOutput: { runs: runs.slice(0, 10).map(jobStructured) },
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return {
        output: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }],
        structuredOutput: { runs: [jobStructured(run)] },
      };
    },
  });
  const searchHistoryTool = defineTool({
    name: "search_history",
    description:
      "Search your own full stored history, including entries from before a reset, handoff or compaction that you can no longer see. Filter by words (query), by tool name (tool), by entry kind, or by entry number range (from_entry, to_entry). Pass entry to read one entry in full by its number. Results come newest first (order oldest to reverse) and are paged with limit and offset; use next_offset for the next page. Each result says whether the entry is active, compacted or before reset.",
    parameters: obj({
      query: opt(str({ description: "Words that must all appear, case-insensitive." })),
      tool: opt(str({ description: "Only calls to and results from this tool, for example bash." })),
      entry: opt(int({ minimum: 1, description: "Read this one entry in full." })),
      kind: opt(
        oneOf(["user", "assistant", "tool_call", "tool_result", "event"]),
      ),
      from_entry: opt(int({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: opt(int({ minimum: 1, description: "Newest entry number to include." })),
      order: opt(oneOf(["newest", "oldest"])),
      limit: opt(int({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: opt(int({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        // Newest first, pinned: storage defaults entries to descending and the tool's own default order is newest.
        let page = await tx.scanEntries({ order: "descending", conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ order: "descending", conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  /**
   * A light subtask: several read-only calls in one turn. Each is a nested call, so the model gets every result together
   * without a child conversation, a second context, or one round trip per fact. Only read tools qualify, which keeps a
   * batch from becoming a way to write without the caller seeing each write; `subagent` stays the channel for work that
   * needs its own transcript.
   */
  const gather = defineTool({
    name: "gather",
    description:
      "Run up to 8 read-only tool calls in one step and get every result together: read a few files, search history, read a named App State field. Each call is nested inside this one, so nothing is written and no child agent starts. Use it when you need several facts before answering.",
    parameters: obj({
      calls: arr(
        obj({
          tool: str({ description: "A read-only tool name, for example read, read_state or search_history." }),
          args: opt(map(union([str(), num()]), { description: "The arguments that tool takes." })),
        }),
        { description: "The calls, in order.", maxItems: MAX_GATHER_CALLS },
      ),
    }),
    replay: "safe",
    structuredOutputSchema: GATHER_RESULT_SCHEMA,
    execute: async (args, api, ctx) => {
      const results: { tool: string; ok: boolean; value: Json; diagnostics: string[] }[] = [];
      for (const [index, call] of args.calls.slice(0, MAX_GATHER_CALLS).entries()) {
        if (call.tool === "gather") throw Error("gather cannot call itself");
        if (!isReadName(call.tool))
          throw Error(`${call.tool} is not a read-only tool, so gather will not run it. Call it yourself.`);
        const nested = await api.executeTool(call.tool, (call.args ?? {}) as JsonObject, ctx, {
          key: `gather-${index + 1}`,
          progress: false,
        });
        results.push({
          tool: call.tool,
          ok: !nested.isError,
          value: nested.structuredOutput ?? null,
          diagnostics: nested.diagnostics.map((d) => d.message),
        });
      }
      return { output: [{ type: "text", text: JSON.stringify(results) }], structuredOutput: { results } };
    },
  });
  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description:
      "Page the human on-call engineer with a short summary. A real side effect: it is not replay-safe, so a crash returns an interrupted result instead of paging again, and it works once per agent. Only use it when the user asks you to page someone.",
    parameters: obj({
      summary: str({ description: "What the engineer needs to know, one or two sentences." }),
      severity: opt(oneOf(["low", "high", "critical"])),
    }),
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const prior = await api.snapshot(Pager, api.conversationId, ctx);
      if (prior?.paged)
        throw Error(
          `Already paged at ${new Date(prior.at).toISOString()} (${prior.page}). ping_on_call_engineer works once per agent.`,
        );
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      api.output("Dialing the on-call engineer…\n");
      await pause(1500);
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        if (pager.paged) throw Error(`Already paged (${pager.page}).`);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      api.output(`Paged on-call, ${severity} severity: ${page}\nWaiting for acknowledgement…\n`);
      await pause(1500);
      api.output("Acknowledged.\n");
      return {
        output: [
          {
            type: "text",
            text: `Paged the on-call engineer (${page}, ${severity}). They acknowledged. Do not page again for this.`,
          },
        ],
      };
    },
  });
  const subagent = defineTool({
    name: "subagent",
    description:
      "Delegate a self-contained task to an owned child conversation. Parent interruption also interrupts the child.",
    parameters: obj({ task: str() }),
    replay: "safe",
    structuredOutputSchema: SUBAGENT_RESULT_SCHEMA,
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const id = await api.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (found) return found.id;
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, { tools: { remove: [subagent] } });
        return child.id;
      }, ctx);
      await api.details({ conversationId: id }, ctx);
      const child = await api.conversation(id, ctx);
      if (!child) throw Error("Child missing");
      const result = await (
        await child.submit(
          { type: "input", content: args.task, requestId: `child:${api.taskId}` },
          ctx,
        )
      ).wait(ctx);
      const answer =
        result.status === "done" && result.type === "input"
          ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
          : undefined;
      return {
        output: [
          { type: "text", text: answer ? JSON.stringify(answer.model) : JSON.stringify(result) },
        ],
        structuredOutput: {
          conversationId: id,
          status: result.status,
          answer: answer ? ((answer.model ?? []) as unknown as WireMessage[]).map(messageText).join("").trim() || null : null,
        },
        details: { conversationId: id },
      };
    },
  });
  const startSession = defineTool({
    name: "start_session",
    description:
      "Start a new session on this device: its own harness, database and working directory, independent of this one. It keeps running if you are interrupted. Returns immediately; you do not wait for it.",
    parameters: obj({
      name: str({ description: "Session name shown in the network tree." }),
      cwd: str({
        description: "Existing folder on this device. Relative paths resolve against your working directory.",
      }),
      model: opt(
        str({ description: "Model id from this device's model list. Default: your current model." }),
      ),
      prompt: opt(
        str({ description: "First message for the new session. Default: none, the session starts idle." }),
      ),
    }),
    replay: "safe",
    ...deferredWhen(options.deferred),
    execute: async (args, api, ctx) => {
      const parent = await api.agent(ctx);
      if (!parent.model) throw Error("This agent has no model to copy");
      const cwd = args.cwd.startsWith("~") || isAbsolute(args.cwd) ? args.cwd : resolve(parent.cwd ?? ".", args.cwd);
      const thinking = THINKING_LEVELS.find((level) => level === parent.thinkingLevel);
      const { session, submissionId } = await spawn({
        key: `start_session:${sessionId}:${api.taskId}`,
        name: args.name,
        cwd,
        model: { provider: parent.model.provider, modelId: args.model ?? parent.model.modelId },
        thinkingLevel: thinking,
        prompt: args.prompt?.trim() || undefined,
      });
      const sent =
        submissionId === undefined
          ? "It has no prompt yet."
          : `Sent its first message as submission #${submissionId}. It runs on its own.`;
      return {
        output: [
          {
            type: "text",
            text: `Started session "${session.name}" (${session.id}) in ${session.cwd} with ${session.model}. ${sent}`,
          },
        ],
        details: { sessionId: session.id, ...(submissionId === undefined ? {} : { submissionId }) },
      };
    },
  });
  const handoff = defineTool({
    name: "handoff",
    description:
      "Start a fresh model context with a concise handoff note. Old transcript stays stored.",
    parameters: obj({ note: str() }),
    ...deferredWhen(options.deferred),
    execute: async (args) => ({
      output: [{ type: "text", text: "Context handed off." }],
      control: { handoff: args.note },
    }),
  });
  return defineExtension({
    name: "playground",
    tasks: jobs.tasks,
    // Each tool declares what it does to the machine, so read-only mode cannot miss one by forgetting to list it.
    tools: [
      classed(readAppState, "read"),
      classed(updateState, "write"),
      classed(listJobs, "read"),
      classed(runJob, "write"),
      classed(checkJob, "read"),
      classed(searchHistoryTool, "read"),
      classed(gather, "read"),
      classed(pingOnCall, "write"),
      classed(subagent, "write"),
      classed(startSession, "write"),
      classed(handoff, "write"),
    ],
    sections: [
      section(
        "playground",
        () =>
          `You are a concise coding agent in dpi-product. Explain only what matters. Use only the tools you are offered; read only agents get no tools that write. Use read_state to inspect App State and update_state to create, update, delete, or increment any field. App State is shared across all agents, sessions, conversations and forks in this product. It survives browser closure, interrupted agents, and backend restarts. Forks use the current shared object rather than a historical copy. Read before writing because other agents and humans can change it. Use only read_state and update_state for this object, never inspect or edit its database files. App State is a flexible JSON object: numbers, booleans, strings, arrays, nested objects, and null all render as live controls in the UI. Read before editing. Use list_durable_jobs and run_durable_job to run a repeatable durable job (a named workflow with checkpointed phases) when asked; pass only the inputs list_durable_jobs documents. Runs continue in the background: check them with check_durable_job, and wait only when asked. Use search_history to look back at earlier messages, tool calls or entries by number, including what came before a reset, handoff or compaction. Use ping_on_call_engineer only when asked to page someone; it works once. Use subagent only when explicitly asked to delegate. Use start_session only when asked to start a new session; it runs on its own. Never claim an action happened without using its tool. Background runs finish independently; do not wait in bash. A browser disconnect does not stop your work.`,
        { tag: false },
      ),
    ],
  });
}
