// What the bridge owes the chat: a message it must still answer. Kept on disk (one small JSON file) so a
// restart, a crash or a deploy does not swallow the reply while the device keeps running the work.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Pending {
  /** The device hook the work was handed to. */
  hook: string;
  chatId: string;
  /** The message to answer on. */
  messageId: string;
  submissionId: number;
  createdAt: number;
}

export const keyOf = (record: Pick<Pending, "hook" | "submissionId">) => `${record.hook}:${record.submissionId}`;

/** A replied key is remembered briefly so a platform retry after a restart cannot answer twice. */
const DONE_TTL = 3_600_000;

type File = { items?: Pending[]; done?: Record<string, number> };

export class PendingStore {
  private items = new Map<string, Pending>();
  private done = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.error(`[bridge] ${line}`),
  ) {
    this.read();
  }

  private read() {
    if (!existsSync(this.file)) return;
    let parsed: File;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as File;
    } catch (e) {
      // A corrupt file must not stop the bridge from starting; the work itself still lives on the device.
      this.log(`state file ${this.file} is unreadable (${(e as Error).message}); starting empty`);
      return;
    }
    for (const item of parsed.items ?? []) {
      if (typeof item?.submissionId === "number" && item.hook && item.chatId && item.messageId)
        this.items.set(keyOf(item), item);
    }
    const cutoff = this.now() - DONE_TTL;
    for (const [key, at] of Object.entries(parsed.done ?? {})) if (at > cutoff) this.done.set(key, at);
  }

  private write() {
    const body: File = { items: [...this.items.values()], done: Object.fromEntries(this.done) };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`cannot write ${this.file}: ${(e as Error).message}`);
    }
  }

  all(): Pending[] {
    return [...this.items.values()];
  }

  has(record: Pick<Pending, "hook" | "submissionId">) {
    return this.items.has(keyOf(record));
  }

  /** False when this submission was already answered within the last hour. */
  unclaimed(record: Pick<Pending, "hook" | "submissionId">) {
    const at = this.done.get(keyOf(record));
    return at === undefined || this.now() - at > DONE_TTL;
  }

  add(record: Pending) {
    this.items.set(keyOf(record), record);
    this.write();
  }

  /** Answered: forget the work, remember that this submission has been replied to. */
  answered(record: Pick<Pending, "hook" | "submissionId">) {
    const key = keyOf(record);
    this.items.delete(key);
    this.done.set(key, this.now());
    const cutoff = this.now() - DONE_TTL;
    for (const [done, at] of this.done) if (at < cutoff) this.done.delete(done);
    this.write();
  }

  /** Gave up (expired, gone, unauthorized): forget the work without claiming a reply. */
  drop(record: Pick<Pending, "hook" | "submissionId">) {
    if (this.items.delete(keyOf(record))) this.write();
  }
}
