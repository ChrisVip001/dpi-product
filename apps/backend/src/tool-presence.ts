// Which tools the model is offered up front, and which it loads with `tool_search`.
//
// Tool definitions are part of every request: fourteen tools with their parameters and descriptions cost about 2,300
// tokens on every turn, whether or not the model calls them. Tools a session uses rarely can be `deferred`: registered
// and callable by other tools, but not rendered into the request until `tool_search` names them; the conversation keeps
// the loaded set (`modelTools.add`), so a tool is only searched for once per branch. Measured on this device's own
// catalogue: fourteen tools, 9,307 characters resident; seven, 4,671 deferred (≈2,327 → ≈1,168 tokens).
//
// It is off by default and turned on per device with `DPI_DEFERRED_TOOLS=on`. Deferral changes what the model sees, and
// every prompt that names a tool ("call run_durable_job") assumes the tool is offered; the switch makes that a decision
// an operator takes, and takes back.

/** Tools a session can live without until it asks for them. Read-only ones are kept: the model reads far more than it writes. */
export const DEFERRED_TOOL_NAMES = [
  "list_durable_jobs",
  "run_durable_job",
  "check_durable_job",
  "search_history",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
  "handoff",
] as const;

/** `DPI_DEFERRED_TOOLS=on` keeps rare tools behind `tool_search`; anything else leaves every tool offered. */
export function deferral(switchValue: string | undefined): boolean {
  return switchValue === "on";
}
