// Signed calls to one device's hook API. The bridge holds a hook secret, never the device token, so a
// compromised bridge can be cut off by editing hooks.json on the device.
import { createHash, createHmac } from "node:crypto";

export type Answer =
  | { submissionId: number; status: "queued" | "pending" }
  | { submissionId: number; status: "done"; answer: { entryId: number; text: string } }
  | { submissionId: number; status: "unanswered"; reason: string };

/** A job run parked in an approval phase, as the device reports it. */
export interface Approval {
  taskId: number;
  job: string;
  title: string;
  run: number;
  phase?: string;
  since: number;
}

export class DeviceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** 4xx means the same request will never work: a missing submission, a rotated secret, a bad hook. */
  get permanent() {
    return this.status >= 400 && this.status < 500;
  }
}

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** `sha256=<hex>` over `timestamp\nMETHOD\nurl\nsha256(body)` — the same scheme the device verifies. */
export const sign = (secret: string, timestamp: string, method: string, url: string, body = "") =>
  createHmac("sha256", secret).update(`${timestamp}\n${method.toUpperCase()}\n${url}\n${hash(body)}`).digest("hex");

export class Device {
  constructor(
    private readonly baseUrl: string,
    private readonly hooks: Record<string, string>,
  ) {}

  private secret(hook: string) {
    const secret = this.hooks[hook];
    if (!secret) throw new DeviceError(0, `No secret for hook "${hook}" in device.hooks`);
    return secret;
  }

  private call(method: "GET" | "POST", hook: string, path: string, payload?: unknown, waitMs = 0) {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(this.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-dpi-hook-timestamp": timestamp,
        "x-dpi-hook-signature": `sha256=${sign(this.secret(hook), timestamp, method, path, body)}`,
      },
      body: payload === undefined ? undefined : body,
      signal: AbortSignal.timeout(waitMs + 20_000),
    });
  }

  /** Hand one requirement to the hook's agent. Returns at once; `read` waits for the answer. */
  async deliver(hook: string, payload: { text: string; chat: string; user?: string; source: string; event: string }) {
    const path = `/v1/hooks/${encodeURIComponent(hook)}`;
    const response = await this.call("POST", hook, path, payload);
    const body = (await response.json().catch(() => undefined)) as
      | { submissionId?: number; status?: string; error?: { message?: string } }
      | undefined;
    if (!response.ok || !body?.submissionId)
      throw new DeviceError(response.status, body?.error?.message ?? `Device answered ${response.status} for hook ${hook}`);
    return body.submissionId;
  }

  /** Job runs in the hook's session that are waiting for a person. */
  async approvals(hook: string): Promise<Approval[]> {
    const response = await this.call("GET", hook, `/v1/hooks/${encodeURIComponent(hook)}/approvals`);
    const body = (await response.json().catch(() => undefined)) as
      | { items?: Approval[]; error?: { message?: string } }
      | undefined;
    if (!response.ok)
      throw new DeviceError(response.status, body?.error?.message ?? `Device answered ${response.status} for approvals`);
    return body?.items ?? [];
  }

  /** Approve or decline one run. Throws when the run is no longer waiting. */
  async decide(hook: string, taskId: number, approved: boolean) {
    const response = await this.call(
      "POST",
      hook,
      `/v1/hooks/${encodeURIComponent(hook)}/approvals/${taskId}`,
      { approved },
    );
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; error?: { message?: string } }
      | undefined;
    if (!response.ok || !body?.ok)
      throw new DeviceError(response.status, body?.error?.message ?? `Device answered ${response.status}`);
    return body;
  }

  /** Wait up to `waitMs` for a submission; returns `pending` when it is still running. */
  async read(hook: string, submissionId: number, waitMs: number): Promise<Answer> {
    const path = `/v1/hooks/${encodeURIComponent(hook)}/submissions/${submissionId}?waitMs=${waitMs}`;
    const response = await this.call("GET", hook, path, undefined, waitMs);
    const body = (await response.json().catch(() => undefined)) as
      | (Answer & { error?: { message?: string } })
      | undefined;
    if (!response.ok || !body)
      throw new DeviceError(response.status, body?.error?.message ?? `Device answered ${response.status}`);
    return body as Answer;
  }
}
