// One place decides which language a surface speaks, and one shape holds the words.
//
// Order, for every surface: an explicit DPI_LANG, then whatever the caller prefers (a stored choice in the
// hub, navigator.language), then the system locale, then English. A candidate that names a language we do
// not ship is skipped, not obeyed, so `LANG=C` still lands on English.

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own words, for a picker. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", zh: "中文" };

export type Dict = Readonly<Record<string, string>>;

/** English is the reference: every other locale must answer the same keys. */
export interface Catalog {
  en: Dict;
  zh: Dict;
}

export type Params = Readonly<Record<string, string | number>>;

const SUPPORTED: readonly string[] = LOCALES;

/**
 * "zh", "zh-CN", "zh_Hans_CN.UTF-8", "EN_us" → a shipped locale; anything else (including "C" and "POSIX")
 * → undefined so the caller keeps looking.
 */
export function matchLocale(tag: string | undefined | null): Locale | undefined {
  if (!tag) return undefined;
  const primary = tag.trim().toLowerCase().split(/[._@-]/)[0] ?? "";
  return SUPPORTED.includes(primary) ? (primary as Locale) : undefined;
}

/** The first candidate that names a shipped language, else English. */
export function resolveLocale(...candidates: Array<string | undefined | null>): Locale {
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

/** Placeholders are `{name}`; a param that is missing leaves the placeholder alone, which shows up in tests. */
export function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}

/** The locale's words, falling back to English (and then to the key itself) so a gap never blanks a screen. */
export function translate(catalog: Catalog, locale: Locale, key: string, params?: Params): string {
  const template = catalog[locale][key] ?? catalog.en[key] ?? key;
  return fill(template, params);
}

/**
 * Everything wrong with a catalog, as lines a test can print: a key a locale is missing, an empty line, a
 * placeholder that drifted from English, or a key English does not have. Empty means aligned.
 */
export function catalogGaps(catalog: Catalog): string[] {
  const holes = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(",");
  const gaps: string[] = [];
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const dict = catalog[locale];
    for (const [key, english] of Object.entries(catalog.en)) {
      const template = dict[key];
      if (template === undefined) gaps.push(`${locale}: missing ${key}`);
      else if (!template.trim()) gaps.push(`${locale}: empty ${key}`);
      else if (holes(template) !== holes(english)) gaps.push(`${locale}: placeholders differ in ${key}`);
    }
    for (const key of Object.keys(dict)) if (!(key in catalog.en)) gaps.push(`${locale}: extra ${key}`);
  }
  return gaps;
}

/** Process env where there is one (CLI); empty in the browser. */
export function envValue(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

/** CLI surfaces: DPI_LANG first, then the POSIX locale variables. */
export function localeFromEnv(): Locale {
  return resolveLocale(
    envValue("DPI_LANG"),
    envValue("LC_ALL"),
    envValue("LANG"),
    envValue("LC_MESSAGES"),
  );
}
