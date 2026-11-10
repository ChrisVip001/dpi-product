// bridge.yaml: who may trigger which agent, and how to answer them. Secrets come from the file or the
// environment, never from the chat platform. Nothing here names a device: `device.url` is just an address.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { Language } from "./card.js";

export interface BridgeConfig {
  /** Card wording; the log stays English. */
  language: Language;
  /** Where answers still owed to a chat are kept across restarts. */
  state: { file: string };
  listen: { host: string; port: number; path: string };
  device: {
    url: string;
    /** Hook name → the same secret the device's hooks.json holds. */
    hooks: Record<string, string>;
    /** How long one hook call may block before the bridge switches to polling. */
    waitMs: number;
    pollMs: number;
    maxWaitMs: number;
  };
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    verificationToken?: string;
    /** When set, a group message must @ this open_id. */
    botOpenId?: string;
    apiBase: string;
    reply: boolean;
    /** Send "收到，开始处理" before the answer. */
    ack: boolean;
    /** Post an interactive card when a job run waits for approval. */
    cards: boolean;
    /** Open ids allowed to press the approval buttons; empty means anyone in a routed chat. */
    approvers: string[];
  };
  /** chat_id → hook name; `"*"` is the fallback for unmapped chats. */
  routes: Record<string, string>;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

/** Relative paths land next to the config, so a service's cwd does not decide where the state lives. */
const beside = (file: string, p: string) => (p.startsWith("~") ? expand(p) : resolve(dirname(resolve(file)), p));

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const int = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function loadConfig(file: string, env = process.env): BridgeConfig {
  if (!existsSync(file)) throw Error(`No bridge config at ${file}. Copy bridge.example.yaml and fill it in.`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw Error(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  const doc = (raw ?? {}) as Record<string, any>;
  const listen = doc.listen ?? {};
  const device = doc.device ?? {};
  const feishu = doc.feishu ?? {};
  const state = doc.state ?? {};

  const url = str(device.url) ?? str(env.DPI_DEVICE_URL);
  if (!url) throw Error(`${file}: device.url is required (for example http://127.0.0.1:4782)`);
  const hooks: Record<string, string> = {};
  for (const [name, secret] of Object.entries((device.hooks ?? {}) as Record<string, unknown>)) {
    const value = str(secret);
    if (!value || value.length < 32) throw Error(`${file}: device.hooks.${name} must be at least 32 characters`);
    hooks[name] = value;
  }
  if (!Object.keys(hooks).length) throw Error(`${file}: device.hooks needs at least one hook name and secret`);

  const appId = str(env.FEISHU_APP_ID) ?? str(feishu.app_id);
  const appSecret = str(env.FEISHU_APP_SECRET) ?? str(feishu.app_secret);
  if (!appId || !appSecret)
    throw Error(`${file}: feishu.app_id and feishu.app_secret are required (or FEISHU_APP_ID / FEISHU_APP_SECRET)`);

  const routes: Record<string, string> = {};
  for (const [chat, hook] of Object.entries((doc.routes ?? {}) as Record<string, unknown>)) {
    const name = str(hook);
    if (!name || !hooks[name]) throw Error(`${file}: routes.${chat} points at unknown hook "${hook}"`);
    routes[chat] = name;
  }

  const encryptKey = str(env.FEISHU_ENCRYPT_KEY) ?? str(feishu.encrypt_key);
  const approvers = (str(env.FEISHU_APPROVERS) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .concat(Array.isArray(feishu.approvers) ? feishu.approvers.map((id: unknown) => String(id)) : []);
  const spoken = str(doc.language) ?? str(env.DPI_LANG) ?? String(env.LANG ?? "");
  return {
    language: spoken.toLowerCase().startsWith("zh") ? "zh" : "en",
    state: { file: beside(file, str(state.file) ?? str(env.BRIDGE_STATE_FILE) ?? "bridge-state.json") },
    listen: {
      host: str(listen.host) ?? "0.0.0.0",
      port: int(listen.port, 4788),
      path: str(listen.path) ?? "/feishu/events",
    },
    device: {
      url: url.replace(/\/+$/, ""),
      hooks,
      waitMs: int(device.wait_ms, 240_000),
      pollMs: int(device.poll_ms, 5_000),
      maxWaitMs: int(device.max_wait_ms, 1_200_000),
    },
    feishu: {
      appId,
      appSecret,
      encryptKey,
      verificationToken: str(env.FEISHU_VERIFICATION_TOKEN) ?? str(feishu.verification_token),
      botOpenId: str(env.FEISHU_BOT_OPEN_ID) ?? str(feishu.bot_open_id),
      apiBase: (str(feishu.api_base) ?? "https://open.feishu.cn").replace(/\/+$/, ""),
      reply: feishu.reply !== false,
      ack: feishu.ack === true,
      cards: feishu.cards !== false,
      approvers,
    },
    routes,
  };
}

/** Where to read the config from: `--config <file>`, `$BRIDGE_CONFIG`, else ./bridge.yaml. */
export function configPath(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf("--config");
  return expand(flagValue(argv, i) ?? env.BRIDGE_CONFIG ?? "bridge.yaml");
}

function flagValue(argv: string[], i: number) {
  if (i < 0) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}
