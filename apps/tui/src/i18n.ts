// The words tui says, in the language this machine speaks: DPI_LANG wins, then LANG/LC_ALL, then English.
// Keys are flat and named after where they appear, so a translator can work from this file alone.
import {
  localeFromEnv,
  translate,
  type Catalog,
  type Locale,
  type Params,
} from "../../sdk/src/i18n.ts";

const en = {
  "main.usage": `usage: tui <device>[:<session>[:<agent>]] [options]
       tui --url <url> --token <token> [--save <id>]

  -s, --session <ref>   session id or name (else a picker opens)
  -a, --agent <ref>     agent id, "main" or name (default: the session's root agent)
  --new <name>          create a session on the device and attach
  --cwd <dir>           working directory on the device for --new (absolute, or relative to its first start dir)
  --model <id>          model for --new (default: the device's default)
  --url, --token        connect to any backend directly (also DPI_URL, DPI_TOKEN)
  --save <id>           store a --url device in ~/.dpi/network.sqlite under <id>`,
  "main.needToken": "--url needs --token (or DPI_TOKEN)",
  "main.noDevice": "{usage}\n\nKnown devices: {devices}",
  "main.none": "none",
  "main.unknownDevice": 'Unknown device "{id}". Known: {devices}',
  "main.noneKnown": "none (add one to dpi-network.yaml)",
  "main.noToken": "No token for {id}. Run: just net register {id}",
  "main.tokenRejected": "{id}: token rejected by {url}",
  "main.offline": "{id} is offline at {url} ({message})",
  "main.noStartDirs": "{id} has no start dirs; pass --cwd",
  "main.unknownModel": "Unknown model {id}. Available: {models}",
  "main.createFailed": "Could not create the session: {message}",

  "app.newOutput": " ↓ new output ",
  "app.noToken": "No token for {id}. Run: just net register {id}",
  "app.pickSessionFirst": "Pick a session first (/sessions).",
  "app.steering": "Steering: joins after the current tool round",
  "app.busyReject": "Agent is busy (reject mode)",
  "app.interrupted": "Interrupted. Background jobs continue.",
  "app.keepsRunning": "The agent keeps running on",
  "app.reattach": ". Reattach:",

  "status.retrying": "retrying: {message}",
  "status.compacting": "compacting…",
  "status.working": "working…",
  "status.escToInterrupt": "esc to interrupt",
  "status.steer": "↪ steer",
  "status.queued": "⏳ queued",
  "status.contextUpdate": "context update",
  "status.live": "● live",
  "status.noAgent": "○ no agent",
  "status.connecting": "◌ connecting",
  "status.failed": "○ {state}",

  "header.device": "device",
  "header.workspace": "workspace",
  "header.noWorkspace": "no workspace",
  "header.agent": "agent",
  "header.fork": "fork",
  "header.subagent": "subagent",

  "footer.ctx": "{percent}% CTX",
  "footer.tokens": "{tokens} tok ${cost}",
  "footer.bg": "{count} bg",

  "cmd.sessions": "switch or create a session on this device",
  "cmd.agents": "switch agent: roots, forks, subagents",
  "cmd.model": "choose this agent's model",
  "cmd.devices": "switch device",
  "cmd.new": "new agent in this session",
  "cmd.fork": "fork at an entry (default: the last reply)",
  "cmd.thinking": "set the thinking level",
  "cmd.compact": "summarize older context",
  "cmd.reset": "start a fresh context",
  "cmd.name": "rename this agent",
  "cmd.tasks": "live tasks in this session",
  "cmd.help": "keys and commands",
  "cmd.quit": "exit (the agent keeps running)",

  "arg.name": "[name]",
  "arg.fork": "[entryId] [name]",
  "arg.level": "<level>",
  "arg.instructions": "[instructions]",
  "arg.handoff": "[handoff note]",
  "arg.newName": "<name>",

  "keys.enter": "send; steers the agent while it works",
  "keys.altEnter": "queue as a follow-up",
  "keys.esc": "interrupt foreground work",
  "keys.shiftTab": "cycle thinking level",
  "keys.ctrlL": "model picker",
  "keys.ctrlO": "expand tool output and thinking",
  "keys.ctrlC": "clear input, or exit when empty",
  "keys.ctrlD": "exit",

  "flash.newAgent": "New agent {name}",
  "flash.nothingToFork": "Nothing to fork yet.",
  "flash.forked": "Forked at #{entry} → {name}",
  "flash.levels": "Levels: {levels}",
  "flash.compaction": "Compaction requested",
  "flash.reset": "New context started; history stays stored",
  "flash.nameUsage": "Usage: /name <name>",
  "flash.renamed": "Agent renamed to {name}",

  "panel.liveTasks": "Live tasks in {name}",
  "panel.session": "session",
  "panel.noLiveTasks": "No live tasks.",
  "panel.bg": "◌ bg",
  "panel.fg": "● fg",
  "panel.taskAgent": "agent #{agent}",
  "panel.escClose": "esc close",
  "panel.helpFooter": "Closing tui never stops the agent. esc to close.",

  "picker.hint": "↑↓ move │ enter select │ type to filter │ esc close",
  "picker.promptHint": "enter confirm │ esc cancel",
  "picker.newSession": "＋ New session",
  "picker.newSessionDesc": "choose a directory on {device}",
  "picker.sessionMeta": "{cwd} │ {count} agents",
  "picker.sessionMetaOne": "{cwd} │ {count} agent",
  "picker.working": "working",
  "picker.sessions": "Sessions on {device}",
  "picker.sessionName": "Session name",
  "picker.defaultSessionName": "New session",
  "picker.sessionCreated": "Session created in {path}",
  "picker.use": "✓ Use {path}",
  "picker.startDirs": "⌂ start dirs",
  "picker.workdir": "Working directory on {device}",
  "picker.model": "Model ({device})",
  "picker.modelSet": "Model: {name} (next turn)",
  "picker.agents": "Agents in {name}",
  "picker.forkAt": "fork @ #{entry}",
  "picker.agentBg": "{count} bg",
  "picker.devices": "Devices",
  "picker.noToken": "no token",
  "picker.noDevices": "No saved devices. Use --url/--token --save <id>.",
  "picker.kind.root": "root",
  "picker.kind.fork": "fork",
  "picker.kind.subagent": "subagent",

  "render.earlierLines": "  │ … {count} earlier lines (ctrl+o)",
} as const;

const zh: Record<keyof typeof en, string> = {
  "main.usage": `用法：tui <设备>[:<会话>[:<代理>]] [选项]
      tui --url <url> --token <token> [--save <id>]

  -s, --session <ref>   会话 id 或名字（不写就打开选择器）
  -a, --agent <ref>     代理 id、"main" 或名字（默认：会话的主代理）
  --new <name>          在设备上新建会话并接上
  --cwd <dir>           --new 的工作目录（绝对路径，或相对设备的第一个起始目录）
  --model <id>          --new 使用的模型（默认：设备默认模型）
  --url, --token        直连任意后端（也可用 DPI_URL、DPI_TOKEN）
  --save <id>           把 --url 设备以 <id> 存进 ~/.dpi/network.sqlite`,
  "main.needToken": "--url 需要配合 --token（或设置 DPI_TOKEN）",
  "main.noDevice": "{usage}\n\n已知设备：{devices}",
  "main.none": "无",
  "main.unknownDevice": "没有这个设备「{id}」。已知：{devices}",
  "main.noneKnown": "无（往 dpi-network.yaml 里加一个）",
  "main.noToken": "设备 {id} 还没有 token。运行：just net register {id}",
  "main.tokenRejected": "{id}：token 被 {url} 拒绝了",
  "main.offline": "{id} 在 {url} 上离线（{message}）",
  "main.noStartDirs": "{id} 没有起始目录；请用 --cwd 指定",
  "main.unknownModel": "没有这个模型 {id}。可用：{models}",
  "main.createFailed": "会话没能建起来：{message}",

  "app.newOutput": " ↓ 有新输出 ",
  "app.noToken": "设备 {id} 还没有 token。运行：just net register {id}",
  "app.pickSessionFirst": "先选一个会话（/sessions）。",
  "app.steering": "已插入：当前这轮工具跑完后接上",
  "app.busyReject": "代理正忙（拒绝模式）",
  "app.interrupted": "已中断。后台任务继续跑。",
  "app.keepsRunning": "代理仍在运行于",
  "app.reattach": "。重新接上：",

  "status.retrying": "重试中：{message}",
  "status.compacting": "压缩上下文…",
  "status.working": "进行中…",
  "status.escToInterrupt": "esc 中断",
  "status.steer": "↪ 插入",
  "status.queued": "⏳ 排队",
  "status.contextUpdate": "上下文更新",
  "status.live": "● 在线",
  "status.noAgent": "○ 无代理",
  "status.connecting": "◌ 连接中",
  "status.failed": "○ {state}",

  "header.device": "设备",
  "header.workspace": "工作区",
  "header.noWorkspace": "未选工作区",
  "header.agent": "代理",
  "header.fork": "分叉",
  "header.subagent": "子代理",

  "footer.ctx": "{percent}% 上下文",
  "footer.tokens": "{tokens} tok ${cost}",
  "footer.bg": "{count} 后台",

  "cmd.sessions": "切换或在本设备新建会话",
  "cmd.agents": "切换代理：主代理、分叉、子代理",
  "cmd.model": "选择这个代理的模型",
  "cmd.devices": "切换设备",
  "cmd.new": "在本会话新建代理",
  "cmd.fork": "从某条记录分叉（默认：最后一条回复）",
  "cmd.thinking": "设置思考档位",
  "cmd.compact": "把较早的上下文做摘要",
  "cmd.reset": "开一段全新的上下文",
  "cmd.name": "给这个代理改名",
  "cmd.tasks": "本会话正在跑的任务",
  "cmd.help": "按键与命令",
  "cmd.quit": "退出（代理继续运行）",

  "arg.name": "[名字]",
  "arg.fork": "[记录id] [名字]",
  "arg.level": "<档位>",
  "arg.instructions": "[说明]",
  "arg.handoff": "[交接说明]",
  "arg.newName": "<名字>",

  "keys.enter": "发送；代理干活时改为插入",
  "keys.altEnter": "排成下一轮",
  "keys.esc": "中断前台工作",
  "keys.shiftTab": "循环切换思考档位",
  "keys.ctrlL": "模型选择器",
  "keys.ctrlO": "展开工具输出与思考",
  "keys.ctrlC": "清空输入；输入为空时退出",
  "keys.ctrlD": "退出",

  "flash.newAgent": "新代理 {name}",
  "flash.nothingToFork": "还没有可分叉的内容。",
  "flash.forked": "已从 #{entry} 分叉 → {name}",
  "flash.levels": "档位：{levels}",
  "flash.compaction": "已请求压缩",
  "flash.reset": "已开启新上下文；历史仍然保留",
  "flash.nameUsage": "用法：/name <名字>",
  "flash.renamed": "代理已改名为 {name}",

  "panel.liveTasks": "{name} 正在跑的任务",
  "panel.session": "会话",
  "panel.noLiveTasks": "没有正在跑的任务。",
  "panel.bg": "◌ 后台",
  "panel.fg": "● 前台",
  "panel.taskAgent": "代理 #{agent}",
  "panel.escClose": "esc 关闭",
  "panel.helpFooter": "关掉 tui 不会停掉代理。esc 关闭。",

  "picker.hint": "↑↓ 移动 │ enter 选中 │ 输入即过滤 │ esc 关闭",
  "picker.promptHint": "enter 确认 │ esc 取消",
  "picker.newSession": "＋ 新建会话",
  "picker.newSessionDesc": "在 {device} 上挑一个目录",
  "picker.sessionMeta": "{cwd} │ {count} 个代理",
  "picker.sessionMetaOne": "{cwd} │ {count} 个代理",
  "picker.working": "进行中",
  "picker.sessions": "{device} 上的会话",
  "picker.sessionName": "会话名",
  "picker.defaultSessionName": "新会话",
  "picker.sessionCreated": "会话已建在 {path}",
  "picker.use": "✓ 使用 {path}",
  "picker.startDirs": "⌂ 起始目录",
  "picker.workdir": "{device} 上的工作目录",
  "picker.model": "模型（{device}）",
  "picker.modelSet": "模型：{name}（下一轮生效）",
  "picker.agents": "{name} 里的代理",
  "picker.forkAt": "分叉于 #{entry}",
  "picker.agentBg": "{count} 后台",
  "picker.devices": "设备",
  "picker.noToken": "无 token",
  "picker.noDevices": "还没有保存的设备。用 --url/--token --save <id>。",
  "picker.kind.root": "主代理",
  "picker.kind.fork": "分叉",
  "picker.kind.subagent": "子代理",

  "render.earlierLines": "  │ … 前面还有 {count} 行（ctrl+o）",
};

export const catalog: Catalog = { en, zh };
export type Key = keyof typeof en;

export const makeT =
  (locale: Locale) =>
  (key: Key, params?: Params): string =>
    translate(catalog, locale, key, params);

export const locale: Locale = localeFromEnv();
export const t = makeT(locale);
export type Translate = typeof t;
