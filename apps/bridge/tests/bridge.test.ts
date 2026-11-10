import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeApp } from "../src/routes.js";
import type { BridgeConfig } from "../src/config.js";

const hookSecret = "hook-secret-at-least-32-characters";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(20);
  }
  throw Error("Timed out");
};

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const signature = (method: string, url: string, body: string, timestamp: string) =>
  `sha256=${createHmac("sha256", hookSecret).update(`${timestamp}\n${method}\n${url}\n${sha(body)}`).digest("hex")}`;

type Recorded = {
  replies: { messageId: string; text: string }[];
  deliveries: Record<string, unknown>[];
  cards: Record<string, any>[];
  patched: Record<string, any>[];
  decisions: { taskId: string; approved: boolean }[];
  reads: string[];
};

/** A fake device and a fake Feishu API, so the whole bridge can run without either. */
async function harness(
  options: { approvers?: string[]; readsUntilDone?: number; stateFile?: string; readError?: number } = {},
) {
  const seen: Recorded = { replies: [], deliveries: [], cards: [], patched: [], decisions: [], reads: [] };
  const stateFile = options.stateFile ?? join(mkdtempSync(join(tmpdir(), "bridge-")), "state.json");
  let reads = 0;

  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/open-apis/auth/v3/tenant_access_token/internal")
        return res.end(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }));
      if (req.url === "/open-apis/im/v1/messages?receive_id_type=chat_id") {
        seen.cards.push(JSON.parse(JSON.parse(body).content));
        return res.end(JSON.stringify({ code: 0, data: { message_id: "om_card_1" } }));
      }
      const reply = req.url?.match(/^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/);
      if (reply) {
        seen.replies.push({ messageId: decodeURIComponent(reply[1]), text: JSON.parse(JSON.parse(body).content).text });
        return res.end(JSON.stringify({ code: 0 }));
      }
      if (req.method === "PATCH" && req.url?.startsWith("/open-apis/im/v1/messages/")) {
        seen.patched.push(JSON.parse(JSON.parse(body).content));
        return res.end(JSON.stringify({ code: 0 }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });

  const device = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const timestamp = String(req.headers["x-dpi-hook-timestamp"] ?? "");
      if (req.headers["x-dpi-hook-signature"] !== signature(req.method ?? "GET", url, body, timestamp)) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { code: "unauthorized", message: "bad signature" } }));
      }
      res.setHeader("content-type", "application/json");
      if (url.endsWith("/approvals") && req.method === "GET")
        return res.end(
          JSON.stringify({
            items: [{ taskId: 12, job: "release-check", title: "发布检查", run: 1, phase: "approve", since: 0 }],
          }),
        );
      if (/\/approvals\/\d+$/.test(url) && req.method === "POST") {
        seen.decisions.push({ taskId: url.split("/").at(-1)!, approved: JSON.parse(body).approved });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === "POST") {
        seen.deliveries.push(JSON.parse(body));
        res.statusCode = 202;
        return res.end(JSON.stringify({ submissionId: 7, status: "queued" }));
      }
      seen.reads.push(url);
      if (options.readError) {
        res.statusCode = options.readError;
        return res.end(JSON.stringify({ error: { code: "gone", message: "no such submission" } }));
      }
      reads += 1;
      if (reads <= (options.readsUntilDone ?? 0))
        return res.end(JSON.stringify({ submissionId: 7, status: "pending" }));
      res.end(JSON.stringify({ submissionId: 7, status: "done", answer: { entryId: 9, text: "改好了，PR #12" } }));
    });
  });

  const [apiPort, devicePort] = [await listen(api), await listen(device)];
  const config: BridgeConfig = {
    language: "zh",
    state: { file: stateFile },
    listen: { host: "127.0.0.1", port: 0, path: "/feishu/events" },
    device: {
      url: `http://127.0.0.1:${devicePort}`,
      hooks: { "feishu-work": hookSecret },
      waitMs: 200,
      pollMs: 20,
      maxWaitMs: 3000,
    },
    feishu: {
      appId: "cli_test",
      appSecret: "secret",
      verificationToken: "vt-1",
      apiBase: `http://127.0.0.1:${apiPort}`,
      reply: true,
      ack: false,
      cards: true,
      approvers: options.approvers ?? [],
    },
    routes: { oc_1: "feishu-work" },
  };

  const server = createServer(bridgeApp(config, { log: () => {} }));
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    stateFile,
    close: () => {
      server.close();
      api.close();
      device.close();
    },
  };
}

const messageEvent = (chat: string, eventId: string) => ({
  schema: "2.0",
  header: { event_id: eventId, event_type: "im.message.receive_v1", token: "vt-1" },
  event: {
    sender: { sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_1",
      chat_id: chat,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 修一下登录" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
    },
  },
});

const cardEvent = (chat: string, action: "approve" | "decline", operator = "ou_user") => ({
  schema: "2.0",
  header: { event_id: `card-${action}`, event_type: "card.action.trigger", token: "vt-1" },
  event: {
    operator: { open_id: operator },
    action: { value: { action, taskId: 12, hook: "feishu-work" }, tag: "button" },
    context: { open_message_id: "om_card_1", open_chat_id: chat },
  },
});

const post = (base: string, body: unknown) =>
  fetch(`${base}/feishu/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a Feishu mention becomes a signed hook call and the answer comes back on the message", async () => {
  const h = await harness();
  try {
    assert.equal((await (await fetch(`${h.base}/healthz`)).json()).ok, true);

    const first = await post(h.base, messageEvent("oc_1", "evt-1"));
    assert.equal(first.status, 200); // answered before the agent ran
    await until(() => h.seen.replies.length === 1);
    assert.deepEqual(h.seen.deliveries[0], {
      text: "修一下登录",
      chat: "oc_1",
      user: "ou_user",
      source: "feishu",
      event: "feishu:evt-1",
    });
    assert.match(h.seen.reads[0], /^\/v1\/hooks\/feishu-work\/submissions\/7\?waitMs=/);
    assert.deepEqual(h.seen.replies[0], { messageId: "om_1", text: "改好了，PR #12" });

    // The platform retried the same event while it ran: one run, one reply.
    await post(h.base, messageEvent("oc_1", "evt-1"));
    await delay(200);
    assert.equal(h.seen.deliveries.length, 1);
    assert.equal(h.seen.replies.length, 1);

    // A chat nobody routed is ignored silently.
    await post(h.base, messageEvent("oc_unknown", "evt-2"));
    await delay(200);
    assert.equal(h.seen.deliveries.length, 1);

    // A forged verification token never reaches the device.
    const forged = await post(h.base, {
      ...messageEvent("oc_1", "evt-3"),
      header: { event_id: "evt-3", event_type: "im.message.receive_v1", token: "wrong" },
    });
    assert.equal(forged.status, 401);

    // The URL challenge is answered in the format Feishu expects.
    const challenge = await post(h.base, { type: "url_verification", challenge: "c-1", token: "vt-1" });
    assert.deepEqual(await challenge.json(), { challenge: "c-1" });
  } finally {
    h.close();
  }
});

test("a waiting run turns into a card, and the button decides on the device", async () => {
  const h = await harness({ readsUntilDone: 4 });
  try {
    await post(h.base, messageEvent("oc_1", "evt-card"));
    await until(() => h.seen.cards.length === 1);

    // The card says what is waiting and carries the decision in its buttons.
    const card = h.seen.cards[0];
    assert.equal(card.header.title.content, "需要你批准：发布检查 #1");
    assert.match(card.elements[0].text.content, /approve/);
    assert.deepEqual(
      card.elements[1].actions.map((a: any) => a.value),
      [
        { action: "approve", taskId: 12, hook: "feishu-work" },
        { action: "decline", taskId: 12, hook: "feishu-work" },
      ],
    );

    // Pressing approve goes back through the hook and answers with a toast.
    const click = await post(h.base, cardEvent("oc_1", "approve"));
    assert.deepEqual(await click.json(), { toast: { type: "success", content: "已批准" } });
    assert.deepEqual(h.seen.decisions, [{ taskId: "12", approved: true }]);

    // The card is replaced with the outcome, and the run still answers in the thread.
    await until(() => h.seen.patched.length === 1);
    assert.equal(h.seen.patched[0].header.title.content, "已批准：发布检查 #1");
    await until(() => h.seen.replies.length === 1);
    assert.equal(h.seen.replies[0].text, "改好了，PR #12");
  } finally {
    h.close();
  }
});

test("only listed approvers may press the button, and only from a routed chat", async () => {
  const h = await harness({ approvers: ["ou_boss"] });
  try {
    const denied = await post(h.base, cardEvent("oc_1", "approve", "ou_user"));
    assert.deepEqual(await denied.json(), { toast: { type: "error", content: "你没有审批权限" } });

    const elsewhere = await post(h.base, cardEvent("oc_other", "approve", "ou_boss"));
    assert.deepEqual(await elsewhere.json(), { toast: { type: "error", content: "这张卡片不属于这个会话" } });

    const allowed = await post(h.base, cardEvent("oc_1", "decline", "ou_boss"));
    assert.deepEqual(await allowed.json(), { toast: { type: "success", content: "已拒绝" } });
    assert.deepEqual(h.seen.decisions, [{ taskId: "12", approved: false }]);
  } finally {
    h.close();
  }
});

const owed = (file: string) => {
  try {
    return ((JSON.parse(readFileSync(file, "utf8")) as { items?: unknown[] }).items ?? []) as Record<string, any>[];
  } catch {
    return [];
  }
};

const seeded = (file: string, item: Record<string, unknown>) =>
  writeFileSync(file, JSON.stringify({ items: [{ createdAt: Date.now(), ...item }] }));

test("a reply owed when the bridge died is answered after the restart, without a second delivery", async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "bridge-")), "state.json");
  seeded(stateFile, { hook: "feishu-work", chatId: "oc_1", messageId: "om_1", submissionId: 7 });
  const h = await harness({ stateFile });
  try {
    await until(() => h.seen.replies.length === 1);
    assert.deepEqual(h.seen.replies[0], { messageId: "om_1", text: "改好了，PR #12" });
    assert.equal(h.seen.deliveries.length, 0); // the work was already handed over; only the answer was lost
    await until(() => owed(stateFile).length === 0);
  } finally {
    h.close();
  }
});

test("a submission the device no longer knows is forgotten instead of retried forever", async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "bridge-")), "state.json");
  seeded(stateFile, { hook: "feishu-work", chatId: "oc_1", messageId: "om_1", submissionId: 7 });
  const h = await harness({ stateFile, readError: 404 });
  try {
    await until(() => owed(stateFile).length === 0);
    await delay(200);
    assert.equal(h.seen.replies.length, 0);
    assert.equal(h.seen.reads.length, 1); // one look, no loop
  } finally {
    h.close();
  }
});

test("the debt is on disk while the agent works and gone once the chat is answered", async () => {
  const h = await harness({ readsUntilDone: 10 });
  try {
    await post(h.base, messageEvent("oc_1", "evt-owed"));
    await until(() => owed(h.stateFile).length === 1);
    const [item] = owed(h.stateFile);
    assert.deepEqual(
      { hook: item.hook, chatId: item.chatId, messageId: item.messageId, submissionId: item.submissionId },
      { hook: "feishu-work", chatId: "oc_1", messageId: "om_1", submissionId: 7 },
    );

    await until(() => h.seen.replies.length === 1);
    await until(() => owed(h.stateFile).length === 0);
  } finally {
    h.close();
  }
});
