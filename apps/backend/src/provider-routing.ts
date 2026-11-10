// Per-request shaping, before the body reaches the provider.
//
// 1.5's `beforeProviderRequest` hook sees the built request body once per attempt and may replace it for that attempt:
// the one place where a device can bound cost and switch model without waiting for a person to reconfigure the agent.
// Two things happen here, both off by default:
//   - a fallback model (`DPI_MODEL_FALLBACK=from>to`) replaces the primary's `model` field, so a rate-limited or broken
//     primary keeps working. Providers dpi speaks (DeepSeek, OpenRouter) are OpenAI-compatible, where `model` is a body
//     field; usage is still attributed to the primary, which is the price of routing below the agent's model choice.
//   - an output cap (`DPI_MAX_OUTPUT_TOKENS`) clamps the tokens a single answer may spend.

import { GenerationTask, defineExtension, hook } from "@earendil-works/pi-durable";
import type { RuntimeTelemetry } from "./telemetry.js";

export type ProviderRouting = {
  /** Replace this model id with `to` in the request body. */
  readonly fallback?: { readonly from: string; readonly to: string };
  /** Clamp an existing output-token field to at most this value. */
  readonly maxOutputTokens?: number;
};

/** `"deepseek-chat>deepseek-reasoner"`; anything malformed is ignored rather than failing every request. */
export function parseRouting(fallback: string | undefined, maxOutputTokens: string | undefined): ProviderRouting {
  const cap = Number(maxOutputTokens);
  const [from, to] = (fallback ?? "").split(">").map((part) => part.trim());
  return {
    ...(from && to && from !== to ? { fallback: { from, to } } : {}),
    ...(Number.isFinite(cap) && cap > 0 ? { maxOutputTokens: Math.floor(cap) } : {}),
  };
}

/** The body to send instead, or `undefined` when nothing changes. Pure, so the rules are testable on their own. */
export function rewriteRequest(
  body: unknown,
  routing: ProviderRouting,
): { readonly payload: Record<string, unknown> } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const payload = { ...(body as Record<string, unknown>) };
  let changed = false;

  const model = typeof payload.model === "string" ? payload.model : undefined;
  if (routing.fallback && model === routing.fallback.from) {
    payload.model = routing.fallback.to;
    changed = true;
  }
  if (routing.maxOutputTokens !== undefined) {
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      const current = payload[key];
      if (typeof current === "number" && current > routing.maxOutputTokens) {
        payload[key] = routing.maxOutputTokens;
        changed = true;
      }
    }
  }
  return changed ? { payload } : undefined;
}

/** The extension a device installs to apply `routing` to every request, and to count what it saw. */
export function createProviderRouting(telemetry: RuntimeTelemetry, routing: ProviderRouting) {
  return defineExtension({
    name: "provider-routing",
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: async (request) => {
          telemetry.metrics.counter("pi.requests").add(1);
          telemetry.metrics.histogram("pi.request.payload_bytes").record(JSON.stringify(request.payload ?? null).length);
          const rewritten = rewriteRequest(request.payload, routing);
          if (!rewritten) return;
          const switched = routing.fallback && (request.payload as { model?: string })?.model === routing.fallback.from;
          if (switched) telemetry.metrics.counter("pi.requests.fallback").add(1);
          return rewritten;
        },
      }),
    ],
  });
}
