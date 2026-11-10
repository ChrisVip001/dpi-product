// The words watch says, in the language this machine speaks: DPI_LANG wins, then LANG/LC_ALL, then English.
// A notification is read out of context, so every line has to stand alone.
import {
  localeFromEnv,
  translate,
  type Catalog,
  type Locale,
  type Params,
} from "../../sdk/src/i18n.ts";

const en = {
  "watch.usage": `usage: watch <device> [options]
       watch --url <url> --token <token> [options]

  --notify <how>   osascript (macOS banner) | stdout | webhook:<url>   (default: osascript on darwin)
  --verbose        also print started/finished lines to stdout
  --once           exit after the first notice (useful for smoke tests)
  -h, --help`,
  "watch.needToken": "--url needs --token (or DPI_TOKEN)",
  "watch.unknownDevice": "unknown device {id}",
  "watch.emptyRegistry": "no device in the registry; run `just net up <id>`",
  "watch.noToken": "device {id} has no token; run `just net register {id}`",
  "watch.watching": "watching {id} at {url}",
  "watch.webhookFailed": "webhook failed: {message}",
  "watch.streamEnded": "stream ended: {message}",
  "watch.fault": "fault: {message}",
  "notice.finished": "✅ {who} finished",
  "notice.turnComplete": "Turn complete.",
  "notice.needsYou": "⏸ {label} needs you",
  "notice.session": "session {id}",
  "notice.offline": "⚠ device offline",
  "notice.online": "✓ device back online",
  "notice.offlineBody": "Retrying until the device answers.",
  "notice.onlineBody": "Streams reconnected.",
} as const;

const zh: Record<keyof typeof en, string> = {
  "watch.usage": `用法：watch <设备> [选项]
      watch --url <url> --token <token> [选项]

  --notify <how>   osascript（macOS 横幅）| stdout | webhook:<url>   （默认：macOS 用 osascript）
  --verbose        同时打印开始/结束的流水
  --once           收到第一条通知后退出（便于冒烟测试）
  -h, --help`,
  "watch.needToken": "--url 需要配合 --token（或设置 DPI_TOKEN）",
  "watch.unknownDevice": "没有这个设备：{id}",
  "watch.emptyRegistry": "注册表里还没有设备；先运行 `just net up <id>`",
  "watch.noToken": "设备 {id} 还没有 token；先运行 `just net register {id}`",
  "watch.watching": "正在关注 {id}（{url}）",
  "watch.webhookFailed": "webhook 发送失败：{message}",
  "watch.streamEnded": "事件流中断：{message}",
  "watch.fault": "故障：{message}",
  "notice.finished": "✅ {who} 已完成",
  "notice.turnComplete": "这一轮结束了。",
  "notice.needsYou": "⏸ {label} 在等你",
  "notice.session": "会话 {id}",
  "notice.offline": "⚠ 设备已离线",
  "notice.online": "✓ 设备已恢复",
  "notice.offlineBody": "正在重试，直到设备响应。",
  "notice.onlineBody": "事件流已重新连上。",
};

export const catalog: Catalog = { en, zh };
export type Key = keyof typeof en;

/** Bind a locale once; tests use it to pin English whatever the machine speaks. */
export const makeT =
  (locale: Locale) =>
  (key: Key, params?: Params): string =>
    translate(catalog, locale, key, params);

export const locale: Locale = localeFromEnv();
export const t = makeT(locale);
export type Translate = typeof t;
