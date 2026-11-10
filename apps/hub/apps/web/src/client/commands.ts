// Composer slash commands: the same names as tui. Unknown commands are sent to the agent as text.
// Descriptions are read at call time, so a language switch reaches the menu without a reload.
import { THINKING_LEVELS, type ThinkingLevel } from "@sdk/api";
import { t, type Key } from "../i18n";
import {
  agentHandle,
  agentState,
  notify,
  refreshDetail,
  select,
  selected,
  sessionHandle,
  showInspector,
  ui,
} from "./store";

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  run: (arg: string) => unknown | Promise<unknown>;
}

const need = <T>(value: T | undefined, what: Key): T => {
  if (value === undefined) throw Error(t("need.missing", { what: t(what) }));
  return value;
};

/** Rebuilt per call so every description follows the current language. */
export const commands = (): SlashCommand[] => [
  {
    name: "compact",
    args: t("slash.args.instructions"),
    description: t("slash.compact.description"),
    run: async (arg) => {
      await need(agentHandle.value, "need.agent").compact(arg || undefined);
      notify(t("slash.compact.done"));
    },
  },
  {
    name: "reset",
    args: t("slash.args.handoff"),
    description: t("slash.reset.description"),
    run: async (arg) => {
      await need(agentHandle.value, "need.agent").reset(arg || undefined);
      notify(t("slash.reset.done"));
    },
  },
  { name: "tasks", description: t("slash.tasks.description"), run: () => showInspector("tasks") },
  {
    name: "new",
    args: t("slash.args.name"),
    description: t("slash.new.description"),
    run: async (arg) => {
      const target = need(selected.value, "need.workspace");
      const created = await need(sessionHandle.value, "need.workspace").createAgent(
        arg ? { name: arg } : {},
      );
      select({ ...target, agentId: created.id });
      notify(t("slash.new.done", { name: created.name }));
    },
  },
  {
    name: "fork",
    args: t("slash.args.fork"),
    description: t("slash.fork.description"),
    run: async (arg) => {
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const explicit = first && /^\d+$/.test(first) ? Number(first) : undefined;
      const name = (explicit === undefined ? [first, ...rest] : rest).filter(Boolean).join(" ");
      const entryId =
        explicit ?? agentState.value.entries.filter((e) => e.kind === "pi.assistant").at(-1)?.id;
      if (entryId === undefined) throw Error(t("slash.fork.nothing"));
      const target = need(selected.value, "need.agent");
      const created = await need(agentHandle.value, "need.agent").fork({
        entryId,
        name: name || undefined,
      });
      select({ ...target, agentId: created.id });
      notify(t("slash.fork.done", { entry: entryId }));
    },
  },
  {
    name: "name",
    args: t("slash.args.newName"),
    description: t("slash.name.description"),
    run: async (arg) => {
      if (!arg) throw Error(t("slash.name.usage"));
      await need(agentHandle.value, "need.agent").rename(arg);
      notify(t("slash.name.done", { name: arg }));
    },
  },
  {
    name: "model",
    description: t("slash.model.description"),
    run: () => (ui.dialog = { kind: "models" }),
  },
  {
    name: "thinking",
    args: t("slash.args.level"),
    description: t("slash.thinking.description", { levels: THINKING_LEVELS.join(", ") }),
    run: async (arg) => {
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel))
        throw Error(t("slash.thinking.levels", { levels: THINKING_LEVELS.join(", ") }));
      await need(agentHandle.value, "need.agent").configure({ thinkingLevel: arg as ThinkingLevel });
      await refreshDetail();
      notify(t("slash.thinking.done", { level: arg }));
    },
  },
  {
    name: "help",
    description: t("slash.help.description"),
    run: () => (ui.dialog = { kind: "help" }),
  },
];

/** `/name rest` → the command and its argument, or undefined when the text is not a known command. */
export function parseCommand(text: string) {
  const m = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = m && commands().find((c) => c.name === m[1]);
  return command ? { command, arg: m![2].trim() } : undefined;
}
