import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Feishu, FeishuFault, decryptFeishu, encryptFeishu } from "../src/feishu.js";

const encryptKey = "test-encrypt-key-0123456789";
const options = {
  appId: "cli_test",
  appSecret: "secret",
  encryptKey,
  verificationToken: "vt-1",
  botOpenId: "ou_bot",
  apiBase: "https://example.invalid",
};

const sign = (timestamp: string, nonce: string, body: string) =>
  createHash("sha256").update(timestamp + nonce + encryptKey + body).digest("hex");

const messageEvent = (overrides: Record<string, any> = {}) => ({
  schema: "2.0",
  header: { event_id: "evt-1", event_type: "im.message.receive_v1", token: "vt-1" },
  event: {
    sender: { sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 修一下登录" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "dpi" }],
      ...overrides,
    },
  },
});

test("encrypt and decrypt round-trip, including non-ASCII text", () => {
  const payload = JSON.stringify({ text: "帮我改个 bug ✅" });
  assert.equal(decryptFeishu(encryptKey, encryptFeishu(encryptKey, payload)), payload);
});

test("verify checks the signature, the token and the encryption", () => {
  const feishu = new Feishu(options);
  const timestamp = "1700000000";
  const nonce = "abc";
  const plain = JSON.stringify(messageEvent());
  const raw = JSON.stringify({ encrypt: encryptFeishu(encryptKey, plain) });
  const headers = {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": sign(timestamp, nonce, raw),
  };

  const payload = feishu.verify(headers, Buffer.from(raw));
  assert.equal(payload.header.event_id, "evt-1");

  assert.throws(
    () => feishu.verify({ ...headers, "x-lark-signature": "0".repeat(64) }, Buffer.from(raw)),
    (e: unknown) => e instanceof FeishuFault && e.status === 401,
  );
  assert.throws(
    () => feishu.verify({}, Buffer.from(raw)),
    (e: unknown) => e instanceof FeishuFault && e.status === 401,
  );

  // A payload whose token does not match is refused even when the signature is right.
  const wrongToken = JSON.stringify({ ...messageEvent(), header: { event_id: "e", event_type: "im.message.receive_v1", token: "nope" } });
  const wrongRaw = JSON.stringify({ encrypt: encryptFeishu(encryptKey, wrongToken) });
  assert.throws(
    () =>
      feishu.verify(
        { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": sign(timestamp, nonce, wrongRaw) },
        Buffer.from(wrongRaw),
      ),
    (e: unknown) => e instanceof FeishuFault && e.status === 401,
  );
});

test("parse turns a mention into the task text and answers the URL challenge", () => {
  const feishu = new Feishu({ ...options, encryptKey: undefined, verificationToken: undefined });
  const inbound = feishu.parse(messageEvent());
  assert.deepEqual(inbound, {
    kind: "message",
    eventId: "evt-1",
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    text: "修一下登录",
    userId: "ou_user",
    mentionsBot: true,
  });

  // A group message without a mention is not for us.
  const silent = feishu.parse(messageEvent({ mentions: [] }));
  assert.equal(silent?.kind === "message" && silent.mentionsBot, false);

  // A mention of somebody else is not for us either.
  const other = feishu.parse(messageEvent({ mentions: [{ key: "@_user_1", id: { open_id: "ou_someone" } }] }));
  assert.equal(other?.kind === "message" && other.mentionsBot, false);

  // Direct chats do not need a mention.
  const p2p = feishu.parse(messageEvent({ chat_type: "p2p", mentions: [] }));
  assert.equal(p2p?.kind === "message" && p2p.mentionsBot, true);

  assert.deepEqual(feishu.parse({ type: "url_verification", challenge: "c-1" }), {
    kind: "challenge",
    challenge: "c-1",
  });
  assert.equal(feishu.parse({ header: { event_type: "im.chat.updated_v1" } }), undefined);
});
