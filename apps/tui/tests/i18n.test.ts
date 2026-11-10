import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogGaps } from "../../sdk/src/i18n.ts";
import { catalog, makeT } from "../src/i18n.ts";

test("both languages carry every line, with the same placeholders", () => {
  assert.deepEqual(catalogGaps(catalog), []);
});

test("a line reads in the language it is bound to", () => {
  assert.equal(makeT("en")("status.live"), "● live");
  assert.equal(makeT("zh")("status.live"), "● 在线");
  assert.equal(
    makeT("zh")("main.noToken", { id: "mac-mini" }),
    "设备 mac-mini 还没有 token。运行：just net register mac-mini",
  );
});

test("the command list and key help are translated, not copied", () => {
  const zh = makeT("zh");
  assert.equal(zh("cmd.sessions"), "切换或在本设备新建会话");
  assert.equal(zh("keys.esc"), "中断前台工作");
  assert.equal(makeT("en")("cmd.sessions"), "switch or create a session on this device");
});
