// The HTTP surface: one POST a platform can retry safely, answered fast, with the real work in the background.
import express, { type NextFunction, type Request, type Response } from "express";
import { approvalCard, decidedCard, type CardApproval } from "./card.js";
import type { BridgeConfig } from "./config.js";
import { Device, DeviceError, type Answer } from "./device.js";
import { Feishu, FeishuFault, type Inbound } from "./feishu.js";
import { PendingStore, type Pending } from "./state.js";

const KEEP_MS = 3_600_000;
const APPROVAL_CHECK_MS = 5_000;
/** Background jobs can reach an approval long after the reply, so known chats are swept on a timer. */
const APPROVAL_SWEEP_MS = 15_000;
/** One read is capped so an approval card still shows up while the agent works. */
const READ_SLICE_MS = 10_000;

type Message = Extract<Inbound, { kind: "message" }>;
type Card = Extract<Inbound, { kind: "card" }>;

/** Feishu wants an answer within seconds; verification runs first, then the platform gets an empty 200. */
export function bridgeApp(config: BridgeConfig, options: { log?: (line: string) => void } = {}) {
  const log = options.log ?? ((line: string) => console.log(`[bridge] ${line}`));
  const feishu = new Feishu(config.feishu);
  const device = new Device(config.device.url, config.device.hooks);
  /** Replies still owed to a chat; on disk so a restart picks them up instead of losing them. */
  const pending = new PendingStore(config.state.file, Date.now, log);
  const seen = new Map<string, number>();
  /** chat ids this bridge has spoken to, and the hook that serves them. */
  const chats = new Map<string, string>();
  /** `${chatId}:${taskId}` — one card per waiting run. */
  const announced = new Set<string>();
  /** Card message id → what it asked, so the outcome can replace it. */
  const cards = new Map<string, CardApproval>();

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true, routes: Object.keys(config.routes).length }));

  app.post(config.listen.path, express.json({ limit: "1mb", verify: keepRaw }), (req, res, next) => {
    let inbound: Inbound | undefined;
    try {
      inbound = feishu.parse(feishu.verify(headersOf(req), rawOf(req)));
    } catch (e) {
      return next(e);
    }
    if (inbound?.kind === "challenge") return void res.json({ challenge: inbound.challenge });
    if (inbound?.kind === "card")
      return void handleCard(inbound, res).catch((e) => {
        if (!res.headersSent) res.json({ toast: { type: "error", content: message(e) } });
      });
    res.json({});
    if (inbound?.kind === "message") void handle(inbound).catch((e) => log(`handling failed: ${message(e)}`));
  });

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof FeishuFault ? err.status : 500;
    if (status >= 500) log(`error: ${message(err)}`);
    res.status(status).json({ error: { code: status === 401 ? "unauthorized" : "invalid", message: message(err) } });
  });

  const routeFor = (chatId: string) => config.routes[chatId] ?? config.routes["*"];

  /** Remember which hook serves a chat, so the sweep can keep watching it. */
  const learn = (chatId: string) => {
    const hook = routeFor(chatId);
    if (hook) chats.set(chatId, hook);
    return hook;
  };

  async function handle(inbound: Message) {
    if (!inbound.text) return log(`ignored an empty message from ${inbound.chatId}`);
    if (!inbound.mentionsBot) return log(`ignored a group message that did not mention the bot`);
    const now = Date.now();
    if (seen.has(inbound.eventId)) return log(`event ${inbound.eventId} is already running`);
    seen.set(inbound.eventId, now);
    for (const [key, at] of seen) if (now - at > KEEP_MS) seen.delete(key);

    const hook = learn(inbound.chatId);
    if (!hook) return log(`no route for chat ${inbound.chatId}`);

    const started = Date.now();
    /** Set once the device owns the work: from then on this chat is owed an answer. */
    let owed: Pending | undefined;
    try {
      if (config.feishu.ack && config.feishu.reply)
        await reply(inbound.messageId, `收到，开始处理：${clip(inbound.text, 40)}`);
      const submissionId = await device.deliver(hook, {
        text: inbound.text,
        chat: inbound.chatId,
        user: inbound.userId,
        source: "feishu",
        event: `feishu:${inbound.eventId}`,
      });
      // Written before the wait, so a crash or a deploy mid-run still leaves the debt on disk.
      owed = { hook, chatId: inbound.chatId, messageId: inbound.messageId, submissionId, createdAt: Date.now() };
      if (config.feishu.reply) pending.add(owed);
      const answer = await waitForAnswer(hook, submissionId, inbound.chatId);
      const text = answerText(answer);
      if (!config.feishu.reply || !text) pending.drop(owed); // nobody to tell, so nothing is owed
      else if (await reply(inbound.messageId, text)) pending.answered(owed);
      else log(`could not answer ${inbound.chatId}; it stays owed and is retried on the next start`);
      log(`answered ${inbound.chatId} via ${hook} in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (e) {
      log(`delivery to ${hook} failed: ${message(e)}`);
      // A 4xx fails the same way forever; anything else may still finish, so the debt is kept.
      if (owed && e instanceof DeviceError && e.permanent) pending.drop(owed);
      if (!config.feishu.reply) return;
      await reply(
        inbound.messageId,
        owed ? "还在跑，跑完我再回这条消息。" : `这次没跑起来：${clip(message(e), 200)}`,
      );
    }
  }

  /** A button press: decide on the device, answer with a toast, then replace the card with the outcome. */
  async function handleCard(inbound: Card, res: Response) {
    const approved = inbound.action === "approve";
    const hook = learn(inbound.chatId);
    if (!hook || (inbound.hook && inbound.hook !== hook))
      return void res.json({ toast: { type: "error", content: wording("wrongChat") } });
    if (config.feishu.approvers.length && !config.feishu.approvers.includes(inbound.operator))
      return void res.json({ toast: { type: "error", content: wording("notAllowed") } });
    try {
      await device.decide(hook, inbound.taskId, approved);
    } catch (e) {
      return void res.json({ toast: { type: "error", content: message(e) } });
    }
    const approval = cards.get(inbound.messageId);
    cards.delete(inbound.messageId);
    res.json({ toast: { type: "success", content: wording(approved ? "approved" : "declined") } });
    if (approval && config.feishu.cards)
      void feishu
        .updateCard(inbound.messageId, decidedCard(approval, approved, config.language, inbound.operator))
        .catch((e) => log(`card update failed: ${message(e)}`));
    log(`${approved ? "approved" : "declined"} task ${inbound.taskId} in ${inbound.chatId}`);
  }

  /** A permanent device error is thrown; a blip is retried, because the work itself is untouched. */
  async function waitForAnswer(hook: string, submissionId: number, chatId: string): Promise<Answer | undefined> {
    const started = Date.now();
    let nextCheck = 0;
    for (;;) {
      let answer: Answer | undefined;
      try {
        answer = await device.read(hook, submissionId, Math.min(config.device.waitMs, READ_SLICE_MS));
      } catch (e) {
        if (e instanceof DeviceError && e.permanent) throw e;
        log(`reading ${hook}#${submissionId} failed: ${message(e)}; retrying`);
      }
      if (answer?.status === "done" || answer?.status === "unanswered") return answer;
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + APPROVAL_CHECK_MS;
        await announce(chatId, hook).catch((e) => log(`approval check failed: ${message(e)}`));
      }
      if (Date.now() - started > config.device.maxWaitMs) return answer;
      await new Promise((resolve) => setTimeout(resolve, config.device.pollMs));
    }
  }

  /** One card per waiting run, so a group can approve without opening the hub. */
  async function announce(chatId: string, hook: string) {
    if (!config.feishu.cards) return;
    for (const item of await device.approvals(hook)) {
      const key = `${chatId}:${item.taskId}`;
      if (announced.has(key)) continue;
      const approval: CardApproval = { ...item, hook };
      const messageId = await feishu.sendCard(chatId, approvalCard(approval, config.language));
      if (messageId) cards.set(messageId, approval);
      announced.add(key);
      log(`asked ${chatId} to decide on ${item.title} #${item.run}`);
    }
  }

  // A job started in the background can reach an approval after the reply, so known chats are swept.
  const sweep = setInterval(() => {
    for (const [chatId, hook] of chats)
      void announce(chatId, hook).catch((e) => log(`approval sweep failed: ${message(e)}`));
  }, APPROVAL_SWEEP_MS);
  sweep.unref?.();

  function wording(key: "approved" | "declined" | "wrongChat" | "notAllowed") {
    const zh = config.language === "zh";
    if (key === "wrongChat") return zh ? "这张卡片不属于这个会话" : "This card does not belong to this chat";
    if (key === "notAllowed") return zh ? "你没有审批权限" : "You are not an approver here";
    if (key === "approved") return zh ? "已批准" : "Approved";
    return zh ? "已拒绝" : "Declined";
  }

  /** True when the chat actually got it; a failed reply keeps the record so it is retried later. */
  async function reply(messageId: string, text: string) {
    try {
      await feishu.reply(messageId, text);
      return true;
    } catch (e) {
      log(`reply failed: ${message(e)}`);
      return false;
    }
  }

  /** A restart: whatever the last process left owing is waited on and answered, or forgotten if it can never be. */
  async function resume(item: Pending) {
    try {
      const answer = await waitForAnswer(item.hook, item.submissionId, item.chatId);
      const text = answerText(answer);
      if (!config.feishu.reply || !text) return pending.drop(item);
      if (await reply(item.messageId, text)) pending.answered(item);
      log(`answered ${item.chatId} from before the restart`);
    } catch (e) {
      if (e instanceof DeviceError && e.permanent) pending.drop(item);
      log(`could not answer ${item.chatId} from before the restart: ${message(e)}`);
    }
  }

  const owed = pending.all();
  if (owed.length) log(`${owed.length} reply(s) left from before the restart`);
  for (const item of owed) void resume(item);

  return app;
}

function answerText(answer: { status: string; answer?: { text: string }; reason?: string } | undefined) {
  if (!answer) return "还在跑，跑完我再回这条消息。";
  if (answer.status === "done") return answer.answer?.text.trim() || "跑完了，但没有文字输出，去对话里看。";
  if (answer.status === "unanswered") return `这次没回答：${answer.reason ?? ""}`;
  return "还在跑，跑完我再回这条消息。";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const rawOf = (req: Request) =>
  Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody)
    ? (req as Request & { rawBody: Buffer }).rawBody
    : Buffer.alloc(0);

const headersOf = (req: Request) => {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers))
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  return out;
};

const keepRaw = (req: Request, _res: Response, buf: Buffer) => {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
};
