// Slash commands. Anything that is not a known command goes to the agent as text.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../../sdk/src/api.ts";
import type { App } from "./app.ts";
import { t } from "./i18n.ts";
import { Panel, pickAgent, pickDevice, pickModel, pickSession } from "./pickers.ts";
import { c } from "./theme.ts";

export const COMMANDS: SlashCommand[] = [
  { name: "sessions", description: t("cmd.sessions") },
  { name: "agents", description: t("cmd.agents") },
  { name: "model", description: t("cmd.model") },
  { name: "devices", description: t("cmd.devices") },
  { name: "new", description: t("cmd.new"), argumentHint: t("arg.name") },
  { name: "fork", description: t("cmd.fork"), argumentHint: t("arg.fork") },
  {
    name: "thinking",
    description: t("cmd.thinking"),
    argumentHint: t("arg.level"),
    getArgumentCompletions: (prefix) =>
      THINKING_LEVELS.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l })),
  },
  { name: "compact", description: t("cmd.compact"), argumentHint: t("arg.instructions") },
  { name: "reset", description: t("cmd.reset"), argumentHint: t("arg.handoff") },
  { name: "name", description: t("cmd.name"), argumentHint: t("arg.newName") },
  { name: "tasks", description: t("cmd.tasks") },
  { name: "help", description: t("cmd.help") },
  { name: "quit", description: t("cmd.quit") },
];

const KEYS: [string, string][] = [
  ["enter", t("keys.enter")],
  ["alt+enter", t("keys.altEnter")],
  ["esc", t("keys.esc")],
  ["shift+tab", t("keys.shiftTab")],
  ["ctrl+l", t("keys.ctrlL")],
  ["ctrl+o", t("keys.ctrlO")],
  ["ctrl+c", t("keys.ctrlC")],
  ["ctrl+d", t("keys.ctrlD")],
];

/** Returns false when `text` is not a command, so the caller sends it to the agent. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  const match = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = COMMANDS.find((c) => c.name === match?.[1]);
  if (!match || !command) return false;
  const arg = match[2].trim();
  const handle = app.handle;
  switch (command.name) {
    case "sessions":
      await pickSession(app);
      break;
    case "agents":
      pickAgent(app);
      break;
    case "model":
      await pickModel(app);
      break;
    case "devices":
      pickDevice(app);
      break;
    case "new":
      await app.run(async () => {
        const created = await app.client.session(app.sessionId!).createAgent(arg ? { name: arg } : {});
        await app.attach(app.sessionId!, created.id);
        app.flash(t("flash.newAgent", { name: created.name }));
      });
      break;
    case "fork": {
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const explicit = first && /^\d+$/.test(first) ? Number(first) : undefined;
      const name = (explicit === undefined ? [first, ...rest] : rest).filter(Boolean).join(" ") || undefined;
      const entryId =
        explicit ?? app.model.state.entries.filter((e) => e.kind === "pi.assistant").at(-1)?.id;
      if (entryId === undefined) return app.flash(t("flash.nothingToFork"), true), true;
      await app.run(async () => {
        const created = await handle!.fork({ entryId, name });
        await app.attach(app.sessionId!, created.id);
        app.flash(t("flash.forked", { entry: entryId, name: created.name }));
      });
      break;
    }
    case "thinking": {
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel))
        return app.flash(t("flash.levels", { levels: THINKING_LEVELS.join(", ") }), true), true;
      await app.run(async () => {
        await handle!.configure({ thinkingLevel: arg as ThinkingLevel });
      });
      break;
    }
    case "compact":
      await app.run(async () => {
        await handle!.compact(arg || undefined);
        app.flash(t("flash.compaction"));
      });
      break;
    case "reset":
      await app.run(async () => {
        await handle!.reset(arg || undefined);
        app.flash(t("flash.reset"));
      });
      break;
    case "name":
      if (!arg) return app.flash(t("flash.nameUsage"), true), true;
      await app.run(async () => {
        await handle!.rename(arg);
        app.flash(t("flash.renamed", { name: arg }));
      });
      break;
    case "tasks":
      app.overlay(
        new Panel(() => {
          const tasks = app.session.state.tasks;
          const lines = [
            c.bold(c.accent(t("panel.liveTasks", { name: app.sessionSummary()?.name ?? t("panel.session") }))),
            "",
          ];
          if (!tasks.length) lines.push(c.muted(t("panel.noLiveTasks")));
          for (const task of tasks)
            lines.push(
              `${task.background ? c.secondary(t("panel.bg")) : c.warn(t("panel.fg"))} #${task.id} ${task.kind} ${c.muted(`${t("panel.taskAgent", { agent: task.conversationId })} │ ${task.state.status}${task.state.phase ? `/${task.state.phase}` : ""}`)}`,
            );
          lines.push("", c.muted(t("panel.escClose")));
          return lines;
        }, () => app.closeOverlay()),
      );
      break;
    case "help":
      app.overlay(
        new Panel(
          () => [
            c.bold(c.accent("tui")),
            c.muted(`${app.device.id} │ ${app.device.url}`),
            "",
            ...KEYS.map(([k, d]) => `${c.secondary(k.padEnd(11))} ${d}`),
            "",
            ...COMMANDS.map((x) => `${c.secondary(`/${x.name}`.padEnd(11))} ${x.description ?? ""}`),
            "",
            c.muted(t("panel.helpFooter")),
          ],
          () => app.closeOverlay(),
        ),
      );
      break;
    case "quit":
      app.exit();
      break;
  }
  return true;
}
