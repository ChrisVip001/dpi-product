// Feishu (Lark) inbound events: URL verification, optional AES decryption, signature and token checks, text
// extraction, and posting the answer back on the triggering message. Only `im.message.receive_v1` matters here.
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export class FeishuFault extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Inbound =
  | { kind: "challenge"; challenge: string }
  | {
      kind: "message";
      eventId: string;
      messageId: string;
      chatId: string;
      chatType: string;
      text: string;
      userId?: string;
      mentionsBot: boolean;
    }
  | {
      kind: "card";
      action: "approve" | "decline";
      taskId: number;
      hook: string;
      chatId: string;
      messageId: string;
      operator: string;
    };

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  botOpenId?: string;
  apiBase: string;
}

type Json = Record<string, any>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A card button carries its decision in `action.value`; anything else is not ours to act on. */
function parseCard(payload: Json): Inbound | undefined {
  const event = (payload.event ?? {}) as Json;
  const raw = event.action?.value;
  let value: Json | undefined;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      value = undefined;
    }
  } else value = raw as Json | undefined;
  const action = value?.action === "approve" || value?.action === "decline" ? value.action : undefined;
  const taskId = Number(value?.taskId);
  if (!action || !Number.isSafeInteger(taskId) || taskId <= 0) return undefined;
  return {
    kind: "card",
    action,
    taskId,
    hook: String(value?.hook ?? ""),
    chatId: String(event.context?.open_chat_id ?? event.open_chat_id ?? ""),
    messageId: String(event.context?.open_message_id ?? event.open_message_id ?? ""),
    operator: String(event.operator?.open_id ?? ""),
  };
}

/** Feishu pads with PKCS#7 and puts a random 16-byte IV in front; the key is sha256(encryptKey). */
export function decryptFeishu(encryptKey: string, encrypted: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const buffer = Buffer.from(encrypted, "base64");
  if (buffer.length < 32) throw new FeishuFault(400, "Encrypted payload is too short");
  const decipher = createDecipheriv("aes-256-cbc", key, buffer.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]);
  const pad = plain[plain.length - 1] ?? 0;
  const end = pad > 0 && pad <= 16 ? plain.length - pad : plain.length;
  return plain.subarray(0, end).toString("utf8");
}

/** Test helper mirroring Feishu's encryption, so the bridge can be exercised without the real platform. */
export function encryptFeishu(encryptKey: string, plaintext: string, iv = Buffer.alloc(16, 7)): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

export class Feishu {
  private cached?: { token: string; until: number };

  constructor(private readonly options: FeishuOptions) {}

  /** Verify the signature (when an encrypt key is set), decrypt, and check the verification token. */
  verify(headers: Record<string, string | undefined>, raw: Buffer): Json {
    const { encryptKey, verificationToken } = this.options;
    if (encryptKey) {
      const timestamp = headers["x-lark-request-timestamp"];
      const nonce = headers["x-lark-request-nonce"];
      const signature = headers["x-lark-signature"];
      if (!timestamp || !nonce || !signature) throw new FeishuFault(401, "Missing Feishu signature headers");
      if (!same(sha256(timestamp + nonce + encryptKey + raw.toString("utf8")), signature))
        throw new FeishuFault(401, "Feishu signature does not match");
    }
    let payload: Json;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Json;
    } catch {
      throw new FeishuFault(400, "Body must be JSON");
    }
    if (payload.encrypt) {
      if (!encryptKey) throw new FeishuFault(400, "Encrypted event but no encrypt_key is configured");
      try {
        payload = JSON.parse(decryptFeishu(encryptKey, String(payload.encrypt))) as Json;
      } catch (e) {
        if (e instanceof FeishuFault) throw e;
        throw new FeishuFault(400, "Cannot decrypt the event");
      }
    }
    if (verificationToken) {
      const token = payload.token ?? payload.header?.token;
      if (!token || !same(String(token), verificationToken))
        throw new FeishuFault(401, "Verification token does not match");
    }
    return payload;
  }

  /** `url_verification` becomes a challenge; a text message becomes a task; a button becomes a decision. */
  parse(payload: Json): Inbound | undefined {
    if (payload.type === "url_verification" && typeof payload.challenge === "string")
      return { kind: "challenge", challenge: payload.challenge };
    if (payload.header?.event_type === "card.action.trigger") return parseCard(payload);
    if (payload.header?.event_type !== "im.message.receive_v1") return undefined;
    const message = payload.event?.message as Json | undefined;
    const sender = payload.event?.sender as Json | undefined;
    if (!message?.message_id || !message.chat_id) return undefined;
    if (message.message_type !== "text") return undefined;

    let text = "";
    try {
      text = String((JSON.parse(String(message.content ?? "{}")) as Json).text ?? "");
    } catch {
      text = "";
    }
    const mentions = Array.isArray(message.mentions) ? (message.mentions as Json[]) : [];
    for (const mention of mentions) {
      const key = String(mention.key ?? "");
      if (key) text = text.split(key).join(" ");
    }
    const chatType = String(message.chat_type ?? "group");
    const botOpenId = this.options.botOpenId;
    const mentionsBot = mentions.some((m) => !botOpenId || String(m.id?.open_id ?? "") === botOpenId);
    return {
      kind: "message",
      eventId: String(payload.header?.event_id ?? ""),
      messageId: String(message.message_id),
      chatId: String(message.chat_id),
      chatType,
      text: text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
      userId: sender?.sender_id?.open_id ? String(sender.sender_id.open_id) : undefined,
      // A direct chat does not need a mention; a group message must have one (and match bot_open_id when set).
      mentionsBot: chatType === "p2p" || (mentions.length > 0 && mentionsBot),
    };
  }

  private async tenantToken(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.token;
    const response = await fetch(`${this.options.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as Json;
    const token = String(body.tenant_access_token ?? "");
    if (!response.ok || !token)
      throw Error(`Feishu token failed: ${body.msg ?? body.code ?? response.status}`);
    const ttl = Number(body.expire ?? 7200);
    this.cached = { token, until: Date.now() + Math.max(ttl - 60, 60) * 1000 };
    return token;
  }

  private async api(method: string, path: string, payload?: unknown) {
    const token = await this.tenantToken();
    const response = await fetch(`${this.options.apiBase}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok || Number(body.code ?? 0) !== 0)
      throw Error(`Feishu ${method} ${path} failed: ${body.msg ?? body.code ?? response.status}`);
    return body;
  }

  /** Answer on the triggering message, so the group keeps the thread. Text only, clipped to a chat length. */
  async reply(messageId: string, text: string) {
    const content = text.length > 4000 ? `${text.slice(0, 3990)}\n…（完整内容在对话里）` : text;
    await this.api("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "text",
      content: JSON.stringify({ text: content }),
    });
  }

  /** Post an interactive card to the chat and return its message id, so it can be updated later. */
  async sendCard(chatId: string, card: unknown) {
    const body = await this.api("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    });
    return String(body.data?.message_id ?? "");
  }

  async updateCard(messageId: string, card: unknown) {
    if (!messageId) return;
    await this.api("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(card),
    });
  }
}
