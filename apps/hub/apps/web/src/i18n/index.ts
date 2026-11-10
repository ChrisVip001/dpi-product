// The language the hub speaks. DPI_LANG on the hub server wins, then the choice saved in ui_state, then the
// browser's own preference; English is the floor. `t` reads the ref, so switching redraws every component.
import { ref } from "vue";
import { LOCALES, LOCALE_NAMES, matchLocale, resolveLocale, translate, type Locale, type Params } from "@sdk/i18n";
import { catalog, type Key } from "./catalog";
import { hub } from "../client/hub";

export { LOCALES, LOCALE_NAMES };
export type { Key, Locale };

const STORAGE_KEY = "ui.locale";

/** Set when the hub runs with DPI_LANG: the environment decides, and the picker disappears. */
export const forced = ref<Locale>();
export const locale = ref<Locale>("en");

export const t = (key: Key, params?: Params): string => translate(catalog, locale.value, key, params);

const STATUS_KEYS: Record<string, Key> = {
  online: "deviceStatus.online",
  offline: "deviceStatus.offline",
  checking: "deviceStatus.checking",
  unauthorized: "deviceStatus.unauthorized",
  mismatch: "deviceStatus.mismatch",
  incompatible: "deviceStatus.incompatible",
};

/** A device status word for badges and tooltips; an unknown status is shown as it is. */
export const deviceStatus = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
};

function apply(next: Locale) {
  locale.value = next;
  document.documentElement.lang = next;
  document.title = t("app.title");
}

/** Persist the choice in the hub's ui_state, unless the environment has the last word. */
export function setLocale(next: Locale) {
  if (forced.value || next === locale.value) return;
  apply(next);
  void hub.uiSet(STORAGE_KEY, next).catch(() => {});
}

/** Before the app mounts, so the first paint is already in the right language. */
export async function initLocale() {
  const config = await fetch("/api/config")
    .then((r) => (r.ok ? (r.json() as Promise<{ locale?: string | null }>) : undefined))
    .catch(() => undefined);
  forced.value = matchLocale(config?.locale);
  const stored = forced.value
    ? undefined
    : matchLocale(await hub.uiGet<string>(STORAGE_KEY).catch(() => undefined));
  apply(resolveLocale(forced.value, stored, navigator.language));
}
