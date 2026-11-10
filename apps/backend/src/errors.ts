import type { ErrorRequestHandler } from "express";
import {
  ConversationBusy,
  ConversationIdle,
  ReadOnlySession,
  SessionFailed,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import type { ErrorCode } from "../../sdk/src/api.js";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  busy: 409,
  idle: 409,
  read_only: 409,
  conflict: 409,
  ambiguous: 409,
  session_failed: 503,
  unavailable: 503,
  internal: 500,
  offline: 503,
};

export class ApiFault extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new ApiFault("invalid", message);
export const notFound = (message: string) => new ApiFault("not_found", message);

const causeOf = (error: unknown) =>
  error instanceof Error ? error.message : error === undefined ? "unknown cause" : String(error);

/**
 * The fault a thrown value becomes. The runtime's own failures each get their own code, so a caller can tell "the session
 * died and must be reopened" from "this session is read-only" from "you raced another writer" — they used to surface as
 * one `unavailable` or `internal` and the reason was only in the log.
 */
export function toFault(err: unknown): ApiFault {
  if (err instanceof ApiFault) return err;
  if (err instanceof ConversationBusy) return new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
  if (err instanceof ConversationIdle) return new ApiFault("idle", "The agent is idle and the input asked to be rejected unless it is busy");
  if (err instanceof SessionFailed)
    return new ApiFault("session_failed", `The session failed and closed (${causeOf(err.cause)}). Reopen it to recover from what was committed.`);
  if (err instanceof ReadOnlySession) return new ApiFault("read_only", "This session is open read-only, so it cannot be changed");
  if (err instanceof StorageRequestError) return invalid(err.message);
  if ((err as { type?: string })?.type === "entity.parse.failed") return invalid("Body must be valid JSON");
  if ((err as { type?: string })?.type === "entity.too.large") return invalid("Body too large");
  if (/App State changed while you were editing/.test(String((err as Error)?.message)))
    return new ApiFault("conflict", (err as Error).message);
  if (
    err instanceof Error &&
    /^(Field|Invalid|Use a JSON Pointer|Increment|The state root|State path|Parent must|Value must|Reserved field|App State must|State is too)/.test(err.message)
  )
    return invalid(err.message);
  return new ApiFault("internal", err instanceof Error ? err.message : "Internal error");
}

export const errorMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  const fault = toFault(err);
  // A fault we did not recognise is a bug: keep the stack, but answer with a code the caller can branch on.
  if (fault.code === "internal") console.error(`[backend] ${req.method} ${req.path}:`, err instanceof Error ? err.stack : err);
  if (res.headersSent) return void res.end();
  res.status(fault.status).json({ error: { code: fault.code, message: fault.message } });
};
