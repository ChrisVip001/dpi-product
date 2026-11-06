// Client-side reducers. Each consumes stream frames and exposes plain state plus change
// notifications, so Vue, the TUI or any other renderer can sit on top without knowing the wire.
import type {
  AgentSummary,
  DeviceStatus,
  Frame,
  InboxItem,
  NetworkDevice,
  SessionSummary,
  TaskNode,
  UsageTotals,
  WireAgentState,
  WireAssistantBlock,
  WireAssistantMessage,
  WireEntry,
  WireSnapshotEvent,
  WireViewUpdate,
  WireUsageState,
} from "./api.js";
import { toTranscript, type LiveTool, type TranscriptItem } from "./transcript.js";

type Listener = () => void;

class Emitter {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  protected emit() {
    for (const fn of this.listeners) fn();
  }
}

// ---------------------------------------------------------------- agent

export interface AgentViewState {
  /** Normalized transcript of the active context plus live generation and tools. */
  items: TranscriptItem[];
  /** Committed entries of the active context, ordered by id. */
  entries: WireEntry[];
  /** True between run_start and run_end (snapshot: `run` present). */
  running: boolean;
  generating: boolean;
  inbox: InboxItem[];
  agent: WireAgentState;
  usage: WireUsageState;
  retry?: { at: number; error: string };
  compactions: number[];
  notices: string[];
  docs: Record<string, unknown>;
  /** Set once the first snapshot arrives. */
  ready: boolean;
}

const emptyAgentState = (): AgentViewState => ({
  items: [],
  entries: [],
  running: false,
  generating: false,
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  compactions: [],
  notices: [],
  docs: {},
  ready: false,
});

export class AgentModel extends Emitter {
  state: AgentViewState = emptyAgentState();
  private entries = new Map<number, WireEntry>();
  private live?: WireAssistantMessage;
  private tools = new Map<string, LiveTool>();

  /** Apply one stream frame; returns true when state changed. */
  apply(frame: Frame): boolean {
    switch (frame.type) {
      case "snapshot":
        this.reset(frame.snapshot);
        this.state.inbox = frame.inbox;
        break;
      case "view":
        this.view(frame.view);
        break;
      case "inbox":
        this.state.inbox = frame.items;
        break;
      case "doc":
        this.state.docs = { ...this.state.docs, [frame.kind]: frame.value };
        break;
      default:
        return false;
    }
    this.rebuild();
    this.emit();
    return true;
  }

  /** Re-render without new data (for example after a UI toggle). */
  touch() {
    this.emit();
  }

  clear() {
    this.entries.clear();
    this.tools.clear();
    this.live = undefined;
    this.state = emptyAgentState();
    this.emit();
  }

  private rebuild() {
    const entries = [...this.entries.values()].sort((a, b) => a.id - b.id);
    this.state.entries = entries;
    this.state.generating = !!this.live;
    this.state.items = toTranscript(entries, this.live, this.tools);
  }

  /**
   * Apply a delta produced by a 1.5+ device: entries append, live fields replace, `reset` replaces the
   * whole entry window. `null` clears a temporal field.
   */
  private view(update: WireViewUpdate) {
    if (update.reset) {
      this.entries.clear();
      this.tools.clear();
      this.live = undefined;
    }
    if (update.entries) for (const entry of update.entries) this.commit(entry);
    if (update.generation !== undefined) {
      this.live =
        update.generation === null
          ? undefined
          : update.generation.message
            ? structuredClone(update.generation.message)
            : this.live;
      this.state.retry = update.generation?.retry;
    }
    if (update.tools)
      this.tools = new Map(
        update.tools.map((slot) => [slot.callId, { name: slot.name, status: slot.status, output: slot.output ?? "" }]),
      );
    if (update.run !== undefined) this.state.running = update.run !== null;
    if (update.compactions) this.state.compactions = update.compactions.map((c) => c.taskId);
    if (update.agent) this.state.agent = update.agent;
    if (update.usage) this.state.usage = update.usage;
    this.state.ready = true;
  }

  private reset(snapshot: WireSnapshotEvent) {
    this.entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    this.live = snapshot.generation?.message ? structuredClone(snapshot.generation.message) : undefined;
    this.tools = new Map(
      snapshot.tools.map((slot) => [
        slot.callId,
        { name: slot.name, status: slot.status, output: slot.output ?? "" },
      ]),
    );
    this.state.running = !!snapshot.run;
    this.state.agent = snapshot.agent;
    this.state.usage = snapshot.usage;
    this.state.retry = snapshot.generation?.retry;
    this.state.compactions = snapshot.compactions.map((c) => c.taskId);
    this.state.ready = true;
  }

  /** Store a committed entry. Resets (sent as message_end) and compactions start a new context head. */
  private commit(entry: WireEntry) {
    this.entries.set(entry.id, entry);
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
      const head = entry.head ?? entry.id;
      for (const id of this.entries.keys()) if (id < head) this.entries.delete(id);
    }
  }
}

// ---------------------------------------------------------------- session

export interface SessionViewState {
  agents: AgentSummary[];
  tasks: TaskNode[];
  usage: UsageTotals;
  ready: boolean;
}

export function agentLabel(agent: Pick<AgentSummary, "id" | "name">) {
  return agent.name;
}

export class SessionModel extends Emitter {
  state: SessionViewState = { agents: [], tasks: [], usage: { models: {}, tools: {} }, ready: false };

  apply(frame: Frame): boolean {
    if (frame.type === "session") {
      this.state = { agents: frame.agents, tasks: frame.tasks, usage: frame.usage, ready: true };
    } else if (frame.type === "agents") this.state = { ...this.state, agents: frame.agents };
    else if (frame.type === "tasks") this.state = { ...this.state, tasks: frame.tasks };
    else if (frame.type === "usage") this.state = { ...this.state, usage: frame.usage };
    else return false;
    this.emit();
    return true;
  }

  clear() {
    this.state = { agents: [], tasks: [], usage: { models: {}, tools: {} }, ready: false };
    this.emit();
  }

  agent(id: number) {
    return this.state.agents.find((a) => a.id === id);
  }

  /** Root → … → id, following fork parents. */
  lineage(id: number): AgentSummary[] {
    return lineage(this.state.agents, id);
  }

  foregroundBusy(agentId: number) {
    return this.state.tasks.some((t) => !t.background && t.conversationId === agentId);
  }

  backgroundTasks(agentId?: number) {
    return this.state.tasks.filter((t) => t.background && (agentId === undefined || t.conversationId === agentId));
  }
}

export function lineage(agents: readonly AgentSummary[], id: number): AgentSummary[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: AgentSummary[] = [];
  const seen = new Set<number>();
  let current: number | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const agent = byId.get(current);
    if (!agent) break;
    out.unshift(agent);
    current = agent.parentId;
  }
  return out;
}

// ---------------------------------------------------------------- network tree

export type TreeNode =
  | {
      type: "device";
      key: string;
      device: NetworkDevice;
      status: DeviceStatus;
      stale: boolean;
      children: TreeNode[];
    }
  | {
      type: "session";
      key: string;
      deviceId: string;
      session: SessionSummary;
      stale: boolean;
      children: TreeNode[];
    }
  | {
      type: "agent";
      key: string;
      deviceId: string;
      sessionId: string;
      agent: AgentSummary;
      stale: boolean;
      children: TreeNode[];
    };

export const deviceKey = (deviceId: string) => deviceId;
export const sessionKey = (deviceId: string, sessionId: string) => `${deviceId}/s/${sessionId}`;
export const agentKey = (deviceId: string, sessionId: string, agentId: number) =>
  `${deviceId}/s/${sessionId}/a/${agentId}`;

/** Nest agents under the agent they forked from or the agent whose task owns them. */
export function agentTree(deviceId: string, session: SessionSummary, stale: boolean): TreeNode[] {
  const nodes = new Map<number, Extract<TreeNode, { type: "agent" }>>();
  for (const agent of session.agents)
    nodes.set(agent.id, {
      type: "agent",
      key: agentKey(deviceId, session.id, agent.id),
      deviceId,
      sessionId: session.id,
      agent,
      stale,
      children: [],
    });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.agent.parentId ?? node.agent.ownerAgentId ?? -1);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function networkTree(devices: readonly NetworkDevice[]): TreeNode[] {
  return devices.map((device) => {
    const stale = device.status !== "online";
    return {
      type: "device",
      key: deviceKey(device.id),
      device,
      status: device.status,
      stale,
      children: (device.tree?.sessions ?? []).map((session) => ({
        type: "session" as const,
        key: sessionKey(device.id, session.id),
        deviceId: device.id,
        session,
        stale,
        children: agentTree(device.id, session, stale),
      })),
    };
  });
}

export class NetworkModel extends Emitter {
  devices: NetworkDevice[] = [];
  apply(frame: Frame): boolean {
    if (frame.type !== "network") return false;
    this.devices = frame.devices;
    this.emit();
    return true;
  }
  device(id: string) {
    return this.devices.find((d) => d.id === id);
  }
  tree() {
    return networkTree(this.devices);
  }
}
