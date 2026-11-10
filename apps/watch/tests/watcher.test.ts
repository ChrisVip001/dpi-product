import { test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, DeviceTree, SessionSummary, TaskNode } from "../../sdk/src/api.ts";
import { catalogGaps, type Locale } from "../../sdk/src/i18n.ts";
import { catalog, makeT } from "../src/i18n.ts";
import { Watcher, type Notice } from "../src/watcher.ts";

/** English unless a test asks otherwise, so an assertion never depends on the machine's LANG. */
function watch(now: () => number = () => 1, locale: Locale = "en") {
  const notices: Notice[] = [];
  return { notices, watcher: new Watcher((notice) => notices.push(notice), now, makeT(locale)) };
}

const session = (id: string, name: string, agents: { id: number; name: string }[]): SessionSummary => ({
  id,
  name,
  cwd: "/work",
  model: "m",
  createdAt: 0,
  dbPath: "",
  busy: false,
  agents: agents.map((agent) => ({ ...agent, named: true, kind: "root" as const, busy: false, background: 0 })),
});

const tree = (...sessions: SessionSummary[]): DeviceTree => ({ uid: "u", name: "device", sessions, at: 0 });

const finished = (sessionId: string, agentId: number, preview?: string, at = 1): Activity => ({
  type: "agent.finished",
  sessionId,
  agentId,
  at,
  ...(preview === undefined ? {} : { preview }),
});

const task = (id: number, status: string, extra: Partial<TaskNode> = {}): TaskNode => ({
  id,
  kind: "pi.tool",
  conversationId: 1,
  background: false,
  state: { status },
  conversations: [1],
  ...extra,
});

test("a finished turn names the agent and carries its preview", () => {
  const { notices, watcher } = watch();
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.activity([finished("s1", 1, "  fixed the   flaky test\nand pushed\n")]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, "✅ triage / main finished");
  assert.equal(notices[0]!.body, "fixed the flaky test and pushed");
  assert.equal(notices[0]!.at, 1);
});

test("a start is progress, not news", () => {
  const { notices, watcher } = watch();
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.activity([{ type: "agent.started", sessionId: "s1", agentId: 1, at: 1 }]);
  assert.equal(notices.length, 0);
});

test("the same finish frame twice notifies once, so a reconnect cannot repeat it", () => {
  const { notices, watcher } = watch();
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.activity([finished("s1", 1, "done", 7)]);
  watcher.activity([finished("s1", 1, "done", 7)]);
  assert.equal(notices.length, 1);
});

test("a long preview is clipped and an empty one still says the turn ended", () => {
  const { notices, watcher } = watch();
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.activity([finished("s1", 1, "x".repeat(500), 1)]);
  watcher.activity([finished("s1", 1, "   ", 2)]);
  assert.equal(notices[0]!.body.length, 140);
  assert.ok(notices[0]!.body.endsWith("…"));
  assert.equal(notices[1]!.body, "Turn complete.");
});

test("without a tree yet, ids stand in for names", () => {
  const { notices, watcher } = watch();
  watcher.activity([finished("s1", 4, undefined)]);
  assert.equal(notices[0]!.title, "✅ s1/4 finished");
});

test("a task that starts waiting needs you, and says so once", () => {
  const { notices, watcher } = watch();
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.tasks("s1", [task(9, "running", { label: "bash", conversationId: 1 })]);
  assert.equal(notices.length, 0);

  watcher.tasks("s1", [task(9, "waiting", { label: "bash", conversationId: 1 })]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, "⏸ bash needs you");
  assert.equal(notices[0]!.body, "triage / main · pi.tool");

  watcher.tasks("s1", [task(9, "waiting", { label: "bash", conversationId: 1 })]);
  assert.equal(notices.length, 1);
});

test("running and sleeping tasks are the agent's business", () => {
  const { notices, watcher } = watch();
  watcher.tasks("s1", [task(1, "running"), task(2, "sleeping")]);
  watcher.tasks("s1", [task(1, "running")]);
  assert.equal(notices.length, 0);
});

test("a task that goes away and waits again notifies again", () => {
  let clock = 0;
  const { notices, watcher } = watch(() => ++clock);
  watcher.tasks("s1", [task(3, "waiting")]);
  watcher.tasks("s1", []);
  watcher.tasks("s1", [task(3, "waiting")]);
  assert.equal(notices.length, 2);
});

test("sessions forget their own tasks only", () => {
  const { notices, watcher } = watch();
  watcher.tasks("s1", [task(1, "waiting")]);
  watcher.tasks("s2", [task(1, "waiting")]);
  // Same id in two sessions is two tasks, and the second does not inherit the first's state.
  assert.equal(notices.length, 2);
  watcher.tasks("s2", []);
  watcher.tasks("s1", [task(1, "waiting")]);
  assert.equal(notices.length, 2);
});

test("the first connection is silent, a drop and the return each notify once", () => {
  const { notices, watcher } = watch();
  watcher.connection(true);
  assert.equal(notices.length, 0);

  watcher.connection(false);
  watcher.connection(false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, "⚠ device offline");

  watcher.connection(true);
  watcher.connection(true);
  assert.equal(notices.length, 2);
  assert.equal(notices[1]!.title, "✓ device back online");
});

test("a device that never announced itself still reports the drop", () => {
  const { notices, watcher } = watch();
  watcher.connection(false);
  assert.equal(notices.length, 1);
});

test("both languages carry every line, with the same placeholders", () => {
  assert.deepEqual(catalogGaps(catalog), []);
});

test("the same events read in Chinese when the machine speaks Chinese", () => {
  const { notices, watcher } = watch(() => 1, "zh");
  watcher.tree(tree(session("s1", "triage", [{ id: 1, name: "main" }])));
  watcher.activity([finished("s1", 1, "改好了")]);
  watcher.tasks("s1", [task(9, "waiting", { label: "bash" })]);
  watcher.connection(false);
  assert.deepEqual(
    notices.map((notice) => notice.title),
    ["✅ triage / main 已完成", "⏸ bash 在等你", "⚠ 设备已离线"],
  );
  assert.equal(notices[0]!.body, "改好了");
  assert.equal(notices[1]!.body, "triage / main · pi.tool");
  assert.equal(notices[2]!.body, "正在重试，直到设备响应。");
});
