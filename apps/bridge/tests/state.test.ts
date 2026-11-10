import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingStore } from "../src/state.js";

const file = () => join(mkdtempSync(join(tmpdir(), "bridge-state-")), "state.json");
const record = { hook: "feishu-work", chatId: "oc_1", messageId: "om_1", submissionId: 7, createdAt: 1_000 };

test("an owed reply is on disk, so a new store on the same file still has it", () => {
  const path = file();
  new PendingStore(path).add(record);
  const again = new PendingStore(path);
  assert.deepEqual(again.all(), [record]);
  assert.equal(again.has(record), true);
  assert.equal(again.unclaimed(record), true);
  assert.equal(statSync(path).mode & 0o777, 0o600); // a chat id is still worth keeping private
});

test("an answered submission is forgotten, and not answered twice within the hour", () => {
  let now = 1_000;
  const path = file();
  const store = new PendingStore(path, () => now);
  store.add(record);
  store.answered(record);
  assert.deepEqual(store.all(), []);
  assert.equal(store.unclaimed(record), false);

  // Long after: the claim itself has expired, and it was not left on disk forever either.
  now += 3_600_001;
  assert.equal(store.unclaimed(record), true);
  assert.equal(new PendingStore(path, () => now).unclaimed(record), true);
});

test("dropping work leaves no claim behind", () => {
  const path = file();
  const store = new PendingStore(path);
  store.add(record);
  store.drop(record);
  assert.deepEqual(new PendingStore(path).all(), []);
  assert.equal(new PendingStore(path).unclaimed(record), true);
});

test("a corrupt state file is reported and starts empty instead of stopping the bridge", () => {
  const path = file();
  writeFileSync(path, "{not json");
  const lines: string[] = [];
  const store = new PendingStore(path, Date.now, (line) => lines.push(line));
  assert.deepEqual(store.all(), []);
  assert.match(lines[0]!, /unreadable/);
});

test("items with a missing id are skipped, so a half-written file cannot resurrect junk", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ items: [record, { hook: "feishu-work", chatId: "oc_2" }] }));
  assert.deepEqual(new PendingStore(path).all(), [record]);
});
