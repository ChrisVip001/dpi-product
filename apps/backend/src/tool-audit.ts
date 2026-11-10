// Every tool result, once, on the way out.
//
// `afterTool` runs on every result the tool task writes — an executed call's and the ones the Harness writes itself
// (unavailable, invalid arguments, blocked, interrupted, restart limit, aborted) — so one hook covers the whole surface
// instead of every tool remembering to mask its own output. Three things happen here, all bounded:
//   - an audit record per call (name, duration, size, whether the result failed), counted into telemetry;
//   - secrets masked in the text the model reads, because `bash` happily prints an environment;
//   - one very long result clipped, so a single command cannot flood the next request's context.
// Nothing here throws: a masking bug must not turn a finished call into a failed one.

import { defineExtension, hook, ToolTask, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { RuntimeTelemetry } from "./telemetry.js";

export type AuditRecord = {
  readonly at: number;
  readonly name: string;
  readonly callId: string;
  /** A call another tool made through `executeTool()`, rather than one the model issued. */
  readonly nested: boolean;
  readonly ok: boolean;
  readonly ms: number;
  readonly chars: number;
  readonly redacted: number;
  readonly truncated: boolean;
};

const MAX_RECORDS = 200;
/** Generous on purpose: it only has to stop a flood, not shorten ordinary output. */
export const DEFAULT_MAX_CHARS = 20_000;

/**
 * Credential shapes worth masking by default. Each replacement keeps one identifying prefix. The assignment rule runs
 * first: it knows where a value ends, so `api_key=sk-…` is masked once instead of twice.
 */
const SECRETS: readonly { readonly pattern: RegExp; readonly mask: (match: string, ...groups: string[]) => string }[] = [
  {
    pattern: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;]{4,})/gi,
    mask: (_m, key, sep) => `${key}${sep}***`,
  },
  { pattern: /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, mask: (m, kind) => `${kind}-***` },
  { pattern: /\bdpi_[A-Za-z0-9_-]{16,}/g, mask: () => "dpi_***" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, mask: () => "gh*_***" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, mask: () => "Bearer ***" },
];

/** Mask credentials in `text`; returns how many were replaced, for the audit line. */
export function redact(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const { pattern, mask } of SECRETS)
    out = out.replace(pattern, (match: string, ...groups: unknown[]) => {
      // Every pattern after the first is global, so `lastIndex` is reset by `replace` itself.
      count += 1;
      return mask(match, ...(groups.filter((g) => typeof g === "string") as string[]));
    });
  return { text: out, count };
}

/**
 * Mask and clip a result's content, part by part, so a multi-part result keeps its order and its images. `chars` is what
 * the model would have read before masking; `omitted` is what the clip removed.
 */
export function sanitize(content: ToolExecutionResult["output"], maxChars: number = DEFAULT_MAX_CHARS) {
  if (!Array.isArray(content)) return undefined;
  let remaining = maxChars;
  let chars = 0;
  let redacted = 0;
  let omitted = 0;
  const parts = content.map((item) => {
    if (item.type !== "text") return item;
    chars += item.text.length;
    const masked = redact(item.text);
    redacted += masked.count;
    if (remaining <= 0) {
      omitted += masked.text.length;
      return { type: "text" as const, text: "" };
    }
    const kept = masked.text.slice(0, remaining);
    omitted += masked.text.length - kept.length;
    remaining -= kept.length;
    return { type: "text" as const, text: kept };
  });
  if (!omitted) return { parts, chars, redacted, truncated: false };
  const last = parts.map((p) => p.type).lastIndexOf("text");
  if (last >= 0) {
    const item = parts[last] as { type: "text"; text: string };
    parts[last] = { type: "text", text: `${item.text}\n…[tool output truncated: ${omitted} more characters]` };
  }
  return { parts, chars, redacted, truncated: true };
}

export function createToolAudit(
  telemetry: RuntimeTelemetry,
  options: { enabled?: boolean; maxChars?: number } = {},
) {
  const enabled = options.enabled ?? true;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const records: AuditRecord[] = [];
  const started = new Map<string, number>();
  const remember = (record: AuditRecord) => {
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();
  };

  const handlers = {
    // Not the wall clock: this only measures one call, and it never outlives the process.
    beforeTool: (call: { readonly id: string }) => {
      started.set(call.id, Date.now());
      return undefined;
    },
    afterTool: (
      call: { readonly id: string; readonly name: string; readonly parent?: unknown },
      result: ToolExecutionResult,
    ) => {
      const at = started.get(call.id);
      started.delete(call.id);
      const cleaned = sanitize(result.output, maxChars);
      const record: AuditRecord = {
        at: Date.now(),
        name: call.name,
        callId: call.id,
        nested: call.parent !== undefined,
        ok: result.isError !== true,
        ms: at === undefined ? 0 : Date.now() - at,
        chars: cleaned?.chars ?? 0,
        redacted: cleaned?.redacted ?? 0,
        truncated: cleaned?.truncated ?? false,
      };
      remember(record);
      telemetry.metrics.counter("pi.tool.calls").add(1);
      if (!record.ok) telemetry.metrics.counter("pi.tool.errors").add(1);
      if (record.redacted > 0) telemetry.metrics.counter("pi.tool.redacted").add(record.redacted);
      if (record.truncated) telemetry.metrics.counter("pi.tool.truncated").add(1);
      telemetry.metrics.histogram("pi.tool.duration_ms").record(record.ms);
      telemetry.metrics.histogram("pi.tool.output_chars").record(record.chars);
      if (!cleaned || (!record.redacted && !record.truncated)) return;
      return { ...result, output: cleaned.parts };
    },
  };

  const extension: Extension = defineExtension({
    name: "tool-audit",
    // Off: no hook at all, so results reach the model exactly as the tools wrote them.
    hooks: enabled ? [hook(ToolTask, handlers)] : [],
  });

  return {
    extension,
    records,
    snapshot() {
      return {
        total: records.length,
        failed: records.filter((r) => !r.ok).length,
        redacted: records.reduce((sum, r) => sum + r.redacted, 0),
        truncated: records.filter((r) => r.truncated).length,
        recent: records.slice(-50),
      };
    },
  };
}

export type ToolAudit = ReturnType<typeof createToolAudit>;
