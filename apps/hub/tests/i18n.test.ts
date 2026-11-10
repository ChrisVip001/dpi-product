import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogGaps, translate } from "../../sdk/src/i18n.js";
import { catalog } from "../apps/web/src/i18n/catalog.ts";

test("both languages carry every screen's words, with the same placeholders", () => {
  assert.deepEqual(catalogGaps(catalog), []);
});

test("English keeps the wording the UI tests and screenshots already rely on", () => {
  assert.equal(translate(catalog, "en", "topbar.newSession"), "New session");
  assert.equal(translate(catalog, "en", "composer.send"), "Send message");
  assert.equal(translate(catalog, "en", "tree.checkTitle"), "Check connection now");
  assert.equal(translate(catalog, "en", "tree.sessionOne", { count: 1 }), "1 session");
  assert.equal(translate(catalog, "en", "tree.sessionMany", { count: 4 }), "4 sessions");
});

test("Chinese reads as Chinese, numbers included", () => {
  assert.equal(translate(catalog, "zh", "topbar.newSession"), "新建会话");
  assert.equal(translate(catalog, "zh", "tree.sessionMany", { count: 4 }), "4 个会话");
  assert.equal(translate(catalog, "zh", "ago.minutes", { n: 3 }), "3 分钟前");
  assert.equal(
    translate(catalog, "zh", "offline.offlineTitle", { id: "mac-mini" }),
    "mac-mini 离线了",
  );
});

test("job definitions the device sends in English are translated by id", () => {
  // The device owns the wire text; the client owns the words, so a known job never shows up half translated.
  assert.equal(translate(catalog, "en", "jobdef.workspaceSnapshot.phase.scan.label"), "Scan");
  assert.equal(translate(catalog, "zh", "jobdef.workspaceSnapshot.phase.scan.label"), "扫描");
  assert.equal(translate(catalog, "zh", "jobdef.workspaceSnapshot.title"), "工作区快照");
  assert.equal(translate(catalog, "zh", "jobdef.releaseCheck.phase.approve.label"), "审批");
  assert.equal(translate(catalog, "zh", "jobdef.changeWatch.phase.watch.label"), "监视");
  // Unknown ids fall back to the device's own words, never to a bare key.
  assert.equal("jobdef.someNewJob.title" in catalog.en, false);
});

test("a sentence split around a number keeps its shape in both languages", () => {
  assert.equal(
    translate(catalog, "en", "context.autoLabel", { tokens: "60K" }),
    "Auto-compact at 60K",
  );
  assert.equal(translate(catalog, "zh", "context.autoLabel", { tokens: "60K" }), "60K 处自动压缩");
});
