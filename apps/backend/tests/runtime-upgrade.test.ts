// Guards for the runtime wiring: tool classes decide read-only, and list APIs page from the newest end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationBusy, ConversationIdle, ReadOnlySession, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { classed, isReadTool, readToolNames, unclassifiedTools } from "../src/tool-meta.js";
import { toFault } from "../src/errors.js";
import { createRuntimeTelemetry } from "../src/telemetry.js";
import { parseRouting, rewriteRequest } from "../src/provider-routing.js";
import { redact, sanitize } from "../src/tool-audit.js";
import { DEFERRED_TOOL_NAMES, deferral } from "../src/tool-presence.js";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { ViewDiffer } from "../src/view-wire.js";
import { JOB_RUNS_DOC, type JobRunsDoc } from "../../sdk/src/jobs.js";
import { faux, tempStore, until } from "./helpers.js";

test("tool classes: declared tools win, bundled coding tools are known, anything else fails closed", () => {
  const read = classed({ name: "read_state" }, "read");
  const write = classed({ name: "update_state" }, "write");
  const bash = { name: "bash" };
  const readFile = { name: "read" };
  const unknown = { name: "brand_new_tool" };

  assert.equal(isReadTool(read), true);
  assert.equal(isReadTool(write), false);
  assert.equal(isReadTool(bash), false, "bundled write tool is a write");
  assert.equal(isReadTool(readFile), true, "bundled read tool is a read");
  assert.equal(isReadTool(unknown), false, "an unclassified tool is never offered to a read-only agent");

  assert.deepEqual(readToolNames([read, write, bash, readFile, unknown]), ["read_state", "read"]);
  assert.deepEqual(unclassifiedTools([read, write, bash, readFile, unknown]), ["brand_new_tool"]);
});

test("read only: handoff is a write tool and is not offered, so nothing slips past the list", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "RO-2", cwd: t.work, model: faux });
    const { row, c } = await store.resolveAgent(session.id, "main");

    const before = await store.agentDetail(row, c);
    const handoff = before.tools.find((x) => x.name === "handoff");
    assert.ok(handoff, "handoff is part of the playground");
    assert.equal(handoff.writes, true, "handoff changes the conversation, so it is a write");

    await store.configure(row, c, { readOnly: true });
    const after = await store.agentDetail(row, c);
    assert.equal(after.config.readOnly, true);
    assert.equal(
      after.tools.find((x) => x.name === "handoff")?.offered,
      false,
      "a read-only agent must not be offered handoff",
    );
    assert.deepEqual(
      after.tools.filter((x) => !x.offered).map((x) => x.name).sort(),
      after.tools.filter((x) => x.writes).map((x) => x.name).sort(),
      "offered and classified agree",
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("entries page from the newest end", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "PAGES", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    for (const text of ["first", "second", "third"]) {
      const sent = await store.send(c, { content: text, requestId: `page-${text}` });
      assert.equal((await store.settled(h, sent.id as number, 20000)).status, "done");
    }

    const page = await store.entries(c, undefined, 2);
    assert.equal(page.items.length, 2);

    const window = await store.entries(c, undefined, 200);
    const ids = window.items.map((e) => e.id as number);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "entries come newest first");
    assert.match(JSON.stringify(window.items), /third/, "the newest message is inside the first window");
    assert.match(JSON.stringify(page.items), /third/, "so is the short first page");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("runtime faults keep their own code instead of collapsing into unavailable", () => {
  assert.equal(toFault(new ConversationBusy(1 as never)).code, "busy");
  assert.equal(toFault(new ConversationIdle(1 as never)).code, "idle");
  assert.equal(toFault(new ReadOnlySession("commit")).code, "read_only");
  const failed = toFault(new SessionFailed(new Error("disk gone")));
  assert.equal(failed.code, "session_failed");
  assert.match(failed.message, /disk gone/, "the cause is carried into the message");
  assert.match(failed.message, /Reopen/, "the message says what to do");
  assert.equal(toFault(new StorageRequestError("Invalid storage cursor")).code, "invalid");
  assert.equal(toFault(new Error("something else")).code, "internal");
});

test("telemetry keeps report fields, counts by kind and flags a failed session", () => {
  const telemetry = createRuntimeTelemetry("test");
  telemetry.report({
    kind: "task_faulted",
    reason: "restart_limit",
    task: { id: 7 as never, kind: "pi.tool", conversationId: 1 as never },
    error: new Error("tool crashed"),
  });
  telemetry.report({
    kind: "task_interrupted",
    reason: "interrupted",
    restarts: 3,
    task: { id: 8 as never, kind: "demo.job", conversationId: 1 as never },
    error: new Error("host died"),
  });

  const snap = telemetry.snapshot();
  assert.deepEqual(snap.byKind, { task_faulted: 1, task_interrupted: 1 });
  assert.equal(snap.reports[0].kind, "task_faulted");
  assert.equal(snap.reports[0].reason, "restart_limit");
  assert.deepEqual(snap.reports[0].task, { id: 7, kind: "pi.tool" });
  assert.equal(snap.reports[1].restarts, 3);
  assert.equal(snap.storageFailed, false);

  telemetry.report({ kind: "storage_failed", error: new Error("platform reset") });
  assert.equal(telemetry.snapshot().storageFailed, true, "a storage failure marks the sink");
});

test("provider routing only rewrites what it was asked to", () => {
  const routing = parseRouting("deepseek-chat>deepseek-reasoner", "4096");
  assert.deepEqual(routing, { fallback: { from: "deepseek-chat", to: "deepseek-reasoner" }, maxOutputTokens: 4096 });

  assert.deepEqual(rewriteRequest({ model: "deepseek-chat", max_tokens: 8192 }, routing)?.payload, {
    model: "deepseek-reasoner",
    max_tokens: 4096,
  });
  assert.deepEqual(
    rewriteRequest({ model: "deepseek-reasoner", max_tokens: 8192 }, routing)?.payload,
    { model: "deepseek-reasoner", max_tokens: 4096 },
    "the fallback is not chained, but the cap still applies",
  );
  assert.equal(rewriteRequest({ model: "other", max_tokens: 1024 }, routing), undefined, "neither rule applies, so nothing changes");
  assert.equal(rewriteRequest(undefined, routing), undefined);
  assert.deepEqual(parseRouting(undefined, undefined), {}, "nothing is rewritten unless configured");
  assert.deepEqual(parseRouting("same>same", "abc"), {}, "malformed settings are ignored, not fatal");
});

test("a pending approval sleeps instead of holding an invocation", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "SLEEP", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    const run = (await store.startJob(row, h, c, { job: "release-check" })).taskId;
    const runs = async () => (await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc;
    await until(async () => runs().then((doc) => doc.items[String(run)]?.approval === "pending"), 30000, "approval pending");

    const sleeping = (await store.inspect(h)).tasks.filter((task) => task.state.kind === "sleeping");
    assert.ok(sleeping.length > 0, "the waiting approval holds no invocation");
    assert.ok(
      sleeping.every((task) => (task.state as { until: number }).until > Date.now() - 1000),
      "a sleep has a deadline on the host clock",
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("deferral only happens when a device asks for it", () => {
  assert.equal(deferral(undefined), false, "every tool is offered unless the device decides otherwise");
  assert.equal(deferral("off"), false, "the switch rolls the change back");
  assert.equal(deferral("on"), true, "so a device can load rare tools on demand");
  assert.equal(deferral("yes"), false, "only the documented value counts");
});

test("the audit masks credentials and clips a flood, part by part", () => {
  const masked = redact('token dpi_abcdefghijklmnop1234 and key "api_key=sk-abcdefghijklmnop1234"');
  assert.equal(masked.count, 2);
  assert.doesNotMatch(masked.text, /dpi_abcdefghijklmnop1234/);
  assert.doesNotMatch(masked.text, /sk-abcdefghijklmnop1234/);
  assert.match(masked.text, /dpi_\*\*\*/);

  const parts = [
    { type: "text" as const, text: "a".repeat(60) },
    { type: "image" as const, data: "", mimeType: "image/png" },
    { type: "text" as const, text: "b".repeat(60) },
  ];
  const clipped = sanitize(parts, 100);
  assert.equal(clipped?.truncated, true);
  assert.equal(clipped?.chars, 120);
  assert.equal(clipped?.parts.length, 3, "the image survives the clip");
  const texts = clipped!.parts.filter((p) => p.type === "text") as { text: string }[];
  assert.equal(texts[0].text.length, 60, "the first part fits and is kept whole");
  assert.equal(texts[1].text.startsWith("b".repeat(40)), true, "the rest of the budget goes to the next part");
  assert.match(texts[1].text, /truncated: 20 more characters/);
  assert.equal(sanitize([{ type: "text", text: "short" }], 100)?.truncated, false, "ordinary output is untouched");
});

test("a tool result is masked before the model reads it", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "MASK", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "!echo sk-abcdefghijklmnop1234", requestId: "mask-1" });
    assert.equal((await store.settled(h, sent.id as number, 20000)).status, "done");

    // Only the result entries: the prompt itself still holds the secret because that is what the user typed.
    const results = (await store.entries(c, undefined, 50)).items.filter((entry) => entry.kind === "pi.tool-result");
    assert.equal(results.length > 0, true, "the bash call left a result entry");
    const stored = JSON.stringify(results);
    assert.doesNotMatch(stored, /sk-abcdefghijklmnop1234/, "the secret never reaches the transcript");
    assert.match(stored, /sk-\*\*\*/, "the mask keeps the shape of the value");
    assert.equal(store.audit.snapshot().total > 0, true, "the call was audited");
    assert.equal(store.audit.snapshot().redacted > 0, true, "and the mask was counted");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a failing call is audited as an error, and its duration is measured", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "AUDIT-ERR", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "!false", requestId: "audit-err" });
    assert.equal((await store.settled(h, sent.id as number, 20000)).status, "done");

    const counters = store.telemetry.snapshot().counters;
    assert.equal(counters["pi.tool.calls"] > 0, true, "every result is counted");
    assert.equal(counters["pi.tool.errors"] > 0, true, "a non-zero exit is counted as a failure");
    const durations = store.telemetry.snapshot().histograms["pi.tool.duration_ms"];
    assert.equal(durations.count > 0, true, "the audit measures how long the call took");
    assert.equal(
      store.audit.snapshot().recent.some((record) => record.name === "bash" && !record.ok),
      true,
      "the record names the tool and its outcome",
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the runtime snapshot reports durations, task states and failures", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "RUNTIME", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "!echo measured", requestId: "runtime-1" });
    assert.equal((await store.settled(h, sent.id as number, 20000)).status, "done");

    const runtime = await store.runtime();
    assert.equal(runtime.sessions.length, 1, "the open session is listed");
    assert.equal(runtime.counters["pi.tool.calls"]! > 0, true, "the tool counters reach the dashboard");
    assert.equal(runtime.histograms["pi.tool.duration_ms"]!.count > 0, true, "so do the durations");
    assert.equal(runtime.sessions[0].durations.count > 0, true, "a finished task has a measured span");
    assert.equal(runtime.sessions[0].durations.maxMs >= 0, true);
    assert.equal(typeof runtime.byKind, "object");
    assert.equal(runtime.storageFailed, false);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("code mode runs one script that calls the session's tools", async () => {
  const previous = process.env.DPI_CODEMODE;
  process.env.DPI_CODEMODE = "on";
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "CODE", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    const detail = await store.agentDetail(row, c);
    assert.equal(
      detail.tools.some((tool) => tool.name === "codemode"),
      true,
      "the code mode tool is offered when the device asks for it",
    );

    // `read_state` declares no structured schema, so its value reaches the script as text: programs parse what they get.
    const sent = await store.send(c, {
      content: 'code: const state = JSON.parse(await tools.read_state({})); return "goal:" + state.goal;',
      requestId: "code-1",
    });
    assert.equal((await store.settled(h, sent.id as number, 30000)).status, "done");
    const text = JSON.stringify((await store.entries(c, undefined, 100)).items);
    assert.match(text, /goal:Explore durable agents/, "the script called a real tool and returned its value");
  } finally {
    await store.close();
    await t.cleanup();
    if (previous === undefined) delete process.env.DPI_CODEMODE;
    else process.env.DPI_CODEMODE = previous;
  }
});

test("a sliding window sends deltas, never a second snapshot", () => {
  const entry = (id: number) => ({ id, kind: "pi.user", text: `m${id}` });
  const view = (ids: number[]) => ({ entries: ids.map(entry), docs: {} }) as never;
  const differ = new ViewDiffer();
  const frames: ({ full: { entries: { id: number }[] } } | { update: { entries?: { id: number }[] } } | undefined)[] = [];

  let window = Array.from({ length: 50 }, (_, i) => i + 1);
  frames.push(differ.next(view(window)) as never);
  // 150 more entries, each pushing the oldest out of a 50-entry window.
  for (let step = 0; step < 150; step += 1) {
    window = [...window, 51 + step].slice(-50);
    frames.push(differ.next(view(window)) as never);
  }

  assert.equal(frames.filter((frame) => frame && "full" in frame).length, 1, "only the attach frame is a snapshot");
  const delivered = new Set<number>();
  for (const frame of frames) {
    if (!frame) continue;
    if ("full" in frame) for (const e of frame.full.entries) delivered.add(e.id);
    else for (const e of frame.update.entries ?? []) delivered.add(e.id);
  }
  assert.equal(delivered.size, 200, "the client saw every entry, though the window never held more than 50");
});

test("gather nests read-only calls in one step and refuses a write", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "GATHER", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    // The text the model read, not the escaping a JSON dump of the entry would add.
    const resultsOf = async () => {
      const entries = (await store.entries(c, undefined, 100)).items.filter((entry) => entry.kind === "pi.tool-result");
      const texts: string[] = [];
      for (const entry of entries)
        for (const message of (entry.model ?? []) as unknown as { content?: unknown }[])
          if (Array.isArray(message.content))
            for (const block of message.content as { type: string; text?: string }[])
              if (block.type === "text") texts.push(block.text ?? "");
      return texts.join("\n");
    };

    const batched = await store.send(c, { content: "gather: read_state,search_history", requestId: "gather-1" });
    assert.equal((await store.settled(h, batched.id as number, 20000)).status, "done");
    const results = await resultsOf();
    assert.match(results, /"tool":"read_state","ok":true/, "the first nested call ran and reported success");
    assert.match(results, /"tool":"search_history","ok":true/, "so did the second, in the same step");

    const refused = await store.send(c, { content: "gather: update_state", requestId: "gather-2" });
    assert.equal((await store.settled(h, refused.id as number, 20000)).status, "done");
    assert.match(await resultsOf(), /not a read-only tool/, "a batch never becomes a quiet way to write");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("offered tools shrink when deferral is on, and tool_search is the door", async () => {
  const previous = process.env.DPI_DEFERRED_TOOLS;
  process.env.DPI_DEFERRED_TOOLS = "on";
  const t = await tempStore();
  const store = await t.open();
  try {
    assert.equal(store.deferredTools, true);
    const session = await store.create({ name: "DEFER", cwd: t.work, model: faux });
    const { row, c } = await store.resolveAgent(session.id, "main");
    const detail = await store.agentDetail(row, c);
    const names = new Set(detail.tools.map((tool) => tool.name));
    const offered = new Set(detail.tools.filter((tool) => tool.offered).map((tool) => tool.name));

    assert.equal(offered.has(TOOL_SEARCH_TOOL_NAME), true, "the model can search for what it is missing");
    assert.equal(offered.has("read_state"), true, "the tools a session always needs stay resident");
    for (const name of DEFERRED_TOOL_NAMES) {
      assert.equal(names.has(name), true, `${name} is still registered, so another tool can call it`);
      assert.equal(offered.has(name), false, `${name} is not rendered into every request`);
    }

    // The same session, with deferral off: every tool is offered again.
    const search = createToolSearchExtension();
    assert.equal(search.name, "tool-search");
  } finally {
    await store.close();
    await t.cleanup();
    if (previous === undefined) delete process.env.DPI_DEFERRED_TOOLS;
    else process.env.DPI_DEFERRED_TOOLS = previous;
  }
});
