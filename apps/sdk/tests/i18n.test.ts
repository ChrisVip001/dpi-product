import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogGaps, fill, matchLocale, resolveLocale, translate, type Catalog } from "../src/i18n.js";

const catalog: Catalog = {
  en: { greet: "Hello {name}", plain: "Plain", only: "English only" },
  zh: { greet: "你好 {name}", plain: "普通" },
};

test("a locale tag is read down to the language it names", () => {
  assert.equal(matchLocale("zh"), "zh");
  assert.equal(matchLocale("zh-CN"), "zh");
  assert.equal(matchLocale("zh_Hans_CN.UTF-8"), "zh");
  assert.equal(matchLocale("EN_us"), "en");
  assert.equal(matchLocale("en_US.UTF-8"), "en");
});

test("a tag we do not ship is skipped, so LANG=C still lands on English", () => {
  assert.equal(matchLocale("C"), undefined);
  assert.equal(matchLocale("POSIX"), undefined);
  assert.equal(matchLocale("fr-FR"), undefined);
  assert.equal(matchLocale(""), undefined);
  assert.equal(matchLocale(undefined), undefined);
});

test("the first candidate that names a shipped language wins", () => {
  assert.equal(resolveLocale("fr", "zh-CN", "en"), "zh");
  assert.equal(resolveLocale(undefined, "en-GB"), "en");
  assert.equal(resolveLocale(), "en");
  assert.equal(resolveLocale("", "C"), "en");
});

test("a missing key falls back to English, then to the key itself", () => {
  assert.equal(translate(catalog, "zh", "only"), "English only");
  assert.equal(translate(catalog, "zh", "nope.at.all"), "nope.at.all");
});

test("a catalog reports its gaps: missing, empty, drifted placeholders, extra keys", () => {
  assert.deepEqual(catalogGaps(catalog), ["zh: missing only"]);

  const drifted: Catalog = {
    en: { greet: "Hello {name}" },
    zh: { greet: "你好", extra: "多余" },
  };
  assert.deepEqual(catalogGaps(drifted), [
    "zh: placeholders differ in greet",
    "zh: extra extra",
  ]);
});

test("placeholders fill from params and stay put when a param is missing", () => {
  assert.equal(translate(catalog, "zh", "greet", { name: "Ada" }), "你好 Ada");
  assert.equal(translate(catalog, "en", "greet", { name: 42 }), "Hello 42");
  assert.equal(fill("Hello {name}"), "Hello {name}");
  assert.equal(fill("{a} and {b}", { a: "x" }), "x and {b}");
});
