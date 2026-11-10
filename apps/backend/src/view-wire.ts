// Translates a pi-durable 1.5 conversation view into the wire shapes the clients already render.
// 1.5 removed the agent event stream (`watchEvents`), so the device derives snapshots and deltas from the
// view instead: one full snapshot on attach, small `view` frames afterwards.
import type { ConversationView, InboxState, LiveState, ToolSlot } from "@earendil-works/pi-durable";
import type {
  WireCompaction,
  WireEntry,
  WireQueued,
  WireRunFailure,
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
    // Why the last run ended without an answer (`restart_limit`, `turn_limit`, ...): a run that stops silently reads as a
    // hang, and 1.5 records the reason rather than throwing.
    ...(live.runFailure ? { failure: clone(live.runFailure) as unknown as WireRunFailure } : {}),
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
 * Turns successive views into a snapshot on attach and `view` updates afterwards: entries append, everything else is
 * compared by value.
 *
 * It never sends a second snapshot. The device's window slides — the watch keeps the newest N entries — so the frame that
 * used to be a full snapshot is now only the entries the client has not seen. The client keeps its own transcript, which
 * is what makes history longer than the window readable: a whole-window resend every time the window slid made the
 * browser drop everything it had, so a 400-entry conversation showed the last 200 after a long run.
 */
export class ViewDiffer {
  private ids = new Set<number>();
  private last = new Map<string, string>();
  private started = false;

  next(view: ConversationView): { full: WireSnapshotEvent } | { update: WireViewUpdate } | undefined {
    const snapshot = snapshotOf(view);
    const fresh = snapshot.entries.filter((entry) => !this.ids.has(entry.id));

    if (!this.started) {
      this.started = true;
      this.ids = new Set(snapshot.entries.map((entry) => entry.id));
      this.last.clear();
      return { full: snapshot };
    }

    // Entries are append-only and the window only ever covers the newest ones, so an id that left it never comes back:
    // forgetting it keeps `ids` the size of the window while the client keeps the full transcript.
    const window = new Set(snapshot.entries.map((entry) => entry.id));
    for (const id of this.ids) if (!window.has(id)) this.ids.delete(id);

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
    put("failure", snapshot.failure ?? null);
    put("generation", snapshot.generation ?? null);
    put("tools", snapshot.tools);
    put("compactions", snapshot.compactions);
    put("inbox", snapshot.inbox);
    put("agent", snapshot.agent);
    put("usage", snapshot.usage);
    return changed ? { update } : undefined;
  }
}
