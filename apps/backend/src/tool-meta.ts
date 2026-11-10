// What each tool does to the machine, decided by the tool itself rather than by a list someone remembers to update.
//
// `configure({ readOnly: true })` removes the tools that create, update or delete. That used to be a hand-kept set of
// names in `store.ts`, so a new write tool stayed offered until someone edited the set — `handoff` was missing from it.
// Here a tool carries its own class: custom tools declare it at definition, the bundled coding tools are classified by
// name, and **anything unclassified is not offered to a read-only agent** (fail closed, not open).

export type ToolClass = "read" | "write";

/** The subset of a tool registration this module needs; avoids importing the pi-durable type everywhere. */
export type NamedTool = { readonly name: string };

const classes = new WeakMap<object, ToolClass>();
/** The same declarations by name, for callers that only have a name: a nested call, a hand-written gate. */
const byName = new Map<string, ToolClass>();

/** Declare what `tool` does to the machine. Returns the same tool, so it can wrap a `defineTool(...)` call. */
export function classed<T extends object>(tool: T, toolClass: ToolClass): T {
  classes.set(tool, toolClass);
  if ("name" in tool && typeof (tool as { name?: unknown }).name === "string") byName.set((tool as { name: string }).name, toolClass);
  return tool;
}

/** Write tools that ship with pi-durable's `CodingTools`. */
const BUILTIN_WRITE = new Set(["bash", "write", "edit"]);
/** Read tools that ship with pi-durable's `CodingTools`. */
const BUILTIN_READ = new Set(["read"]);

/**
 * Whether a read-only agent may be offered `tool`. A declared class wins; then the bundled coding tools; anything else
 * counts as a write so it is never offered by accident.
 */
export function isReadTool(tool: NamedTool & object): boolean {
  const declared = classes.get(tool);
  if (declared !== undefined) return declared === "read";
  if (BUILTIN_READ.has(tool.name)) return true;
  if (BUILTIN_WRITE.has(tool.name)) return false;
  return false;
}

/**
 * Whether a tool *name* is one that only reads. Same rule as `isReadTool`, for a caller that holds a name rather than
 * the registration (a nested call requested by the model), and the same fail-closed default.
 */
export function isReadName(name: string): boolean {
  const declared = byName.get(name);
  if (declared !== undefined) return declared === "read";
  if (BUILTIN_READ.has(name)) return true;
  return false;
}

/** Names of tools offered to a read-only agent; used by the read-only test and by the agent detail panel. */
export function readToolNames(tools: readonly (NamedTool & object)[]): string[] {
  return tools.filter(isReadTool).map((t) => t.name);
}

/**
 * Tools nobody classified: not declared, not a bundled coding tool. They are treated as writes, so this list is empty in
 * a healthy build — the unit test fails when a new tool is added without a class.
 */
export function unclassifiedTools(tools: readonly (NamedTool & object)[]): string[] {
  return tools
    .filter((t) => classes.get(t) === undefined && !BUILTIN_READ.has(t.name) && !BUILTIN_WRITE.has(t.name))
    .map((t) => t.name);
}
