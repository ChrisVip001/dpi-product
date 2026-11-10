// Decides what is worth interrupting a person for. Pure state machine: no I/O, so it is testable.
//
// The rule this file encodes: notify on things that need a human (an agent finished, a task waits for
// approval or input, the device went away), never on progress. A watched window is still being watched.
import type { Activity, DeviceTree, TaskNode } from "../../sdk/src/api.ts";
import { t as speak, type Translate } from "./i18n.ts";

export interface Notice {
  /** Stable per event, so a reconnect cannot repeat a notice. */
  key: string;
  title: string;
  body: string;
  at: number;
}

export type Notifier = (notice: Notice) => void;

const clip = (text: string, max = 140) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export class Watcher {
  private names = new Map<string, string>();
  private seen = new Set<string>();
  private taskStatus = new Map<string, string>();
  private online?: boolean;

  constructor(
    private readonly notify: Notifier,
    private readonly now: () => number = Date.now,
    private readonly t: Translate = speak,
  ) {}

  /** Names come from the tree; activity frames only carry ids. */
  tree(tree: DeviceTree) {
    this.names.clear();
    for (const session of tree.sessions)
      for (const agent of session.agents) this.names.set(`${session.id}/${agent.id}`, `${session.name} / ${agent.name}`);
  }

  activity(items: readonly Activity[]) {
    for (const item of items) {
      if (item.type !== "agent.finished") continue;
      const who = this.names.get(`${item.sessionId}/${item.agentId}`) ?? `${item.sessionId}/${item.agentId}`;
      this.emit({
        key: `finished:${item.sessionId}:${item.agentId}:${item.at}`,
        title: this.t("notice.finished", { who }),
        body: clip((item.preview ?? "").replace(/\s+/g, " ").trim() || this.t("notice.turnComplete")),
        at: this.now(),
      });
    }
  }

  /**
   * Live tasks of one session. A task that starts waiting for a child (an approval, a person's input)
   * is the only task transition worth a notification: running and sleeping are the agent's business.
   */
  tasks(sessionId: string, tasks: readonly TaskNode[]) {
    const live = new Set<string>();
    for (const task of tasks) {
      const key = `${sessionId}:${task.id}`;
      live.add(key);
      const status = task.state.status;
      const previous = this.taskStatus.get(key);
      this.taskStatus.set(key, status);
      if (previous === status) continue;
      if (status === "waiting") {
        const label = task.label ?? task.kind;
        this.emit({
          key: `waiting:${key}:${this.now()}`,
          title: this.t("notice.needsYou", { label }),
          body: clip(
            `${this.names.get(`${sessionId}/${task.conversationId}`) ?? this.t("notice.session", { id: sessionId })} · ${task.kind}`,
          ),
          at: this.now(),
        });
      }
    }
    for (const key of this.taskStatus.keys())
      if (key.startsWith(`${sessionId}:`) && !live.has(key)) this.taskStatus.delete(key);
  }

  /** Stream health: one notice when the device goes away, one when it is back. */
  connection(ok: boolean) {
    if (this.online === ok) return;
    const first = this.online === undefined;
    this.online = ok;
    if (ok && first) return;
    this.emit({
      key: `connection:${ok}:${this.now()}`,
      title: ok ? this.t("notice.online") : this.t("notice.offline"),
      body: ok ? this.t("notice.onlineBody") : this.t("notice.offlineBody"),
      at: this.now(),
    });
  }

  private emit(notice: Notice) {
    if (this.seen.has(notice.key)) return;
    this.seen.add(notice.key);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    this.notify(notice);
  }
}
