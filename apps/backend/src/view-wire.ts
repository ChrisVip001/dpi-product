// Translates a pi-durable 1.5 conversation view into the wire shapes the clients already render.
// 1.5 removed the agent event stream (`watchEvents`), so the device derives snapshots and deltas from the
// view instead: one full snapshot on attach, small `view` frames afterwards.
import type { ConversationView, InboxState, LiveState, ToolSlot } from "@earendil-works/pi-durable";
import type {
  WireCompaction,
  WireEntry,
  WireQueued,
  WireSnapshotEvent,
  WireToolSlot,
  WireViewUpdate,
} from "../../sdk/src/api.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Built-in state documents carried by every conversation view. */
const liveState = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

const queued = (view: ConversationView): WireQueued[] =>
  (((view.docs["pi.inbox"] as InboxState | undefined)?.items ?? []) as unknown as WireQueued[]).map(
    (item) => ({ id: item.id, mode: item.mode }),
  );

const slotOf = (slot: ToolSlot): WireToolSlot => ({
  callId: slot.callId,
  name: slot.name,
  status: slot.status,
  ...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
  ...(slot.output === undefined ? {} : { output: slot.output }),
  ...(slot.droppedBytes === undefined ? {} : { droppedBytes: slot.droppedBytes }),
  ...(slot.droppedLines === undefined ? {} : { droppedLines: slot.droppedLines }),
  ...(slot.details === undefined ? {} : { details: slot.details }),
});

const compactionOf = (status: NonNullable<LiveState["compactions"]>[number]): WireCompaction => ({
  taskId: status.taskId,
  reason: status.trigger,
  blocking: status.blocking,
  attempt: status.attempt,
  ...(status.retry ? { retry: { ...status.retry } } : {}),
});

/** The complete agent state a fresh client needs. */
export function snapshotOf(view: ConversationView): WireSnapshotEvent {
  const live = liveState(view);
  const generation = live.generation;
  return {
    type: "snapshot",
    entries: clone(view.entries) as unknown as WireEntry[],
    ...(live.run ? { run: { inputs: [...live.run.inputs] } } : {}),
    ...(generation
      ? {
          generation: {
            attempt: generation.attempt,
            ...(generation.message ? { message: clone(generation.message) } : {}),
            ...(generation.retry ? { retry: { ...generation.retry } } : {}),
            ...(generation.deferred ? { deferred: { ...generation.deferred } } : {}),
          },
        }
      : {}),
    tools: (live.tools ?? []).map(slotOf),
    compactions: (live.compactions ?? []).map(compactionOf),
    inbox: queued(view),
    agent: (view.docs["pi.agent"] ?? {}) as unknown as WireSnapshotEvent["agent"],
    usage: (view.docs["pi.usage"] ?? { models: {}, tools: {} }) as unknown as WireSnapshotEvent["usage"],
  };
}

/**
 * Turns successive views into either a fresh snapshot (window slid, or first frame) or the smallest
 * `view` update that still lets the client render. Entries are append-only; everything else is compared
 * by value.
 */
export class ViewDiffer {
  private ids = new Set<number>();
  private last = new Map<string, string>();
  private started = false;

  next(view: ConversationView): { full: WireSnapshotEvent } | { update: WireViewUpdate } | undefined {
    const snapshot = snapshotOf(view);
    const fresh = snapshot.entries.filter((entry) => !this.ids.has(entry.id));
    const slid =
      this.started && this.ids.size > 0 && fresh.length === snapshot.entries.length && snapshot.entries.length > 0;

    if (!this.started || slid) {
      this.started = true;
      this.ids = new Set(snapshot.entries.map((entry) => entry.id));
      this.last.clear();
      return { full: snapshot };
    }

    const update: WireViewUpdate = {};
    let changed = false;
    const put = (key: keyof WireViewUpdate, value: unknown) => {
      const json = JSON.stringify(value ?? null);
      if (this.last.get(key) === json) return;
      this.last.set(key, json);
      (update as Record<string, unknown>)[key] = value;
      changed = true;
    };

    if (fresh.length) {
      for (const entry of fresh) this.ids.add(entry.id);
      put("entries", fresh);
    }
    put("run", snapshot.run ?? null);
    put("generation", snapshot.generation ?? null);
    put("tools", snapshot.tools);
    put("compactions", snapshot.compactions);
    put("inbox", snapshot.inbox);
    put("agent", snapshot.agent);
    put("usage", snapshot.usage);
    return changed ? { update } : undefined;
  }
}
