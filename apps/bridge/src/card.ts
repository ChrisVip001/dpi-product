// The one thing a chat user must click: an approval. Buttons carry the decision, so the callback needs no state.
import type { Approval } from "./device.js";

export type Language = "zh" | "en";

const WORDS = {
  zh: {
    title: (text: string) => `需要你批准：${text}`,
    body: (phase: string) => `阶段：**${phase}**\n批准之前不会 push、提 PR 或回写平台。`,
    approve: "批准",
    decline: "拒绝",
    approved: (text: string) => `已批准：${text}`,
    declined: (text: string) => `已拒绝：${text}`,
    meta: (job: string, run: number) => `${job} · 第 ${run} 次运行`,
    by: (who: string) => `由 ${who} 处理`,
  },
  en: {
    title: (text: string) => `Needs your approval: ${text}`,
    body: (phase: string) => `Phase: **${phase}**\nNothing is pushed, published or written back until you approve.`,
    approve: "Approve",
    decline: "Decline",
    approved: (text: string) => `Approved: ${text}`,
    declined: (text: string) => `Declined: ${text}`,
    meta: (job: string, run: number) => `${job} · run ${run}`,
    by: (who: string) => `by ${who}`,
  },
} as const;

export interface CardApproval extends Approval {
  /** The device hook the decision goes back through. */
  hook: string;
}

const heading = (approval: CardApproval) => `${approval.title} #${approval.run}`;

export function approvalCard(approval: CardApproval, language: Language) {
  const words = WORDS[language];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: words.title(heading(approval)) },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: words.body(approval.phase ?? "approval") } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: words.approve },
            type: "primary",
            value: { action: "approve", taskId: approval.taskId, hook: approval.hook },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: words.decline },
            type: "danger",
            value: { action: "decline", taskId: approval.taskId, hook: approval.hook },
          },
        ],
      },
    ],
  };
}

export function decidedCard(approval: CardApproval, approved: boolean, language: Language, by?: string) {
  const words = WORDS[language];
  const meta = [words.meta(approval.job, approval.run), by ? words.by(by) : ""].filter(Boolean).join(" · ");
  return {
    config: { wide_screen_mode: true },
    header: {
      template: approved ? "green" : "red",
      title: {
        tag: "plain_text",
        content: (approved ? words.approved : words.declined)(heading(approval)),
      },
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content: meta } }],
  };
}
