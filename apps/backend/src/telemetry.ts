// What the runtime tells its host, kept as fields instead of a formatted string.
//
// `HarnessOptions.onReport` used to be `console.error("[durable]", String(error))`, which threw away `kind`, the task, the
// extension and the reason — so a storage failure, a task that ran out of restarts and a hook that threw all looked the
// same in the log, and nothing could be counted. This sink keeps the last N reports, counts them by kind, and exposes
// spans and metrics to the device API. It implements `TelemetryContext` itself, so no tracing dependency is needed yet.

import type { Report } from "@earendil-works/pi-durable";
import type {
  SpanAttributes,
  SpanOptions,
  TelemetryContext,
  TelemetryCounter,
  TelemetryHistogram,
  TelemetryMetrics,
  TelemetrySpan,
  TelemetryUpDownCounter,
} from "@earendil-works/pi-telemetry";

const MAX_REPORTS = 200;
const MAX_SAMPLES = 256;

type Attribute = string | number | boolean;
export type ReportRecord = {
  readonly at: number;
  readonly kind: string;
  readonly message: string;
  readonly task?: { readonly id: number; readonly kind: string };
  readonly extension?: string;
  readonly reason?: string;
  readonly restarts?: number;
};
export type SpanRecord = {
  readonly at: number;
  readonly name: string;
  readonly ms: number;
  readonly status: "ok" | "error";
  readonly attributes: Readonly<Record<string, Attribute>>;
};

const attributes = (input: SpanAttributes | undefined): Record<string, Attribute> => {
  const out: Record<string, Attribute> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
};

/** A ring of the last `size` values; telemetry must never grow without bound in a long-running device. */
const ring = <T>(size: number, values: T[] = []) => {
  const push = (value: T) => {
    values.push(value);
    if (values.length > size) values.shift();
  };
  return { values, push };
};

/** In-process counters and histograms: enough to show throughput and durations, no exporter yet. */
class InMemoryMetrics implements TelemetryMetrics {
  readonly counters = new Map<string, number>();
  readonly histograms = new Map<string, number[]>();
  counter(name: string): TelemetryCounter {
    return { add: (value) => this.counters.set(name, (this.counters.get(name) ?? 0) + value) };
  }
  upDownCounter(name: string): TelemetryUpDownCounter {
    return { add: (value) => this.counters.set(name, (this.counters.get(name) ?? 0) + value) };
  }
  histogram(name: string): TelemetryHistogram {
    return {
      record: (value) => {
        const samples = this.histograms.get(name) ?? [];
        samples.push(value);
        if (samples.length > MAX_SAMPLES) samples.shift();
        this.histograms.set(name, samples);
      },
    };
  }
}

export class RuntimeTelemetry implements TelemetryContext {
  readonly metrics = new InMemoryMetrics();
  readonly reports = ring<ReportRecord>(MAX_REPORTS);
  readonly spans = ring<SpanRecord>(MAX_REPORTS);
  readonly byKind = new Map<string, number>();
  /** Set by a `storage_failed` report: the session cannot run or commit until it is reopened. */
  storageFailed = false;

  constructor(private readonly label = "device") {}

  /** One structured line per report, and the counters the dashboard and the operator read. */
  report(report: Report): void {
    const info = report;
    const task = "task" in info && info.task ? { id: info.task.id as number, kind: info.task.kind } : undefined;
    const line: ReportRecord = {
      at: Date.now(),
      kind: info.kind,
      message: report.error instanceof Error ? report.error.message : String(report.error),
      task,
      extension: "extension" in info ? info.extension : undefined,
      reason: "reason" in info ? info.reason : undefined,
      restarts: "restarts" in info ? info.restarts : undefined,
    };
    this.reports.push(line);
    this.byKind.set(line.kind, (this.byKind.get(line.kind) ?? 0) + 1);
    this.metrics.counter("pi.durable.reports").add(1);
    if (info.kind === "storage_failed") this.storageFailed = true;
    const where = [
      `kind=${line.kind}`,
      line.task ? `task=${line.task.id}:${line.task.kind}` : "",
      line.extension ? `extension=${line.extension}` : "",
      line.reason ? `reason=${line.reason}` : "",
      line.restarts !== undefined ? `restarts=${line.restarts}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.error(`[durable:${this.label}] ${where}: ${line.message}`);
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const started = Date.now();
    const collected = attributes(options.attributes);
    let status: "ok" | "error" = "ok";
    const span: TelemetrySpan = {
      metrics: this.metrics,
      addLink: () => {},
      addEvent: () => {},
      setAttributes: (next) => Object.assign(collected, attributes(next)),
      setStatus: (next) => {
        if (next.status === "error") status = "error";
      },
      startSpan: (child, run) => this.startSpan(child, run),
    };
    const done = (ms: number) => this.spans.push({ at: started, name: options.name, ms, status, attributes: collected });
    try {
      const result = callback(span);
      if (result instanceof Promise)
        return result.then(
          (value) => {
            done(Date.now() - started);
            return value;
          },
          (error: unknown) => {
            status = "error";
            done(Date.now() - started);
            throw error;
          },
        );
      done(Date.now() - started);
      return Promise.resolve(result);
    } catch (error) {
      status = "error";
      done(Date.now() - started);
      throw error;
    }
  }

  /** Counters, report lines and span timings, for the device API and the runtime panel. */
  snapshot() {
    return {
      label: this.label,
      storageFailed: this.storageFailed,
      reports: [...this.reports.values],
      byKind: Object.fromEntries(this.byKind),
      counters: Object.fromEntries(this.metrics.counters),
      spans: [...this.spans.values],
      histograms: Object.fromEntries(
        [...this.metrics.histograms].map(([name, samples]) => [
          name,
          {
            count: samples.length,
            total: samples.reduce((sum, value) => sum + value, 0),
            max: samples.length ? Math.max(...samples) : 0,
          },
        ]),
      ),
    };
  }
}

export const createRuntimeTelemetry = (label?: string) => new RuntimeTelemetry(label);
