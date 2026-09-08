/**
 * T06: sanitized audit events (architecture.md §10, decisions.md #10).
 *
 * Default: metadata only — `{ts, kind, feature, scope, targetId?, byteCounts,
 * decision, degraded?}`. Payload snippets are recorded ONLY at user-enabled
 * verbosity, and then only after passing through the redactor. Any key not
 * in the allow-list is stripped. Events serialize to JSON lines; no secret
 * material may survive (defensively checked with `looksSecretBearing`).
 */

import {
  looksSecretBearing,
  type RedactionOptions,
  redactText,
} from "./redaction.ts";

export interface AuditEvent {
  ts: string;
  kind: string;
  feature?: string;
  scope?: string;
  targetId?: string;
  byteCounts?: Record<string, number>;
  decision: string;
  degraded?: boolean;
  /** Only present when snippets are enabled AND the snippet passed redaction. */
  snippet?: string;
}

export type AuditVerbosity = "metadata" | "snippets";

export interface AuditSinkOptions {
  verbosity?: AuditVerbosity;
  redaction?: RedactionOptions;
  now?: () => Date;
}

const ALLOWED_KEYS = new Set([
  "ts",
  "kind",
  "feature",
  "scope",
  "targetId",
  "byteCounts",
  "decision",
  "degraded",
  "snippet",
]);

export class AuditSink {
  private readonly verbosity: AuditVerbosity;
  private readonly redaction: RedactionOptions;
  private readonly nowFn: () => Date;
  private readonly lines: string[] = [];

  constructor(opts: AuditSinkOptions = {}) {
    this.verbosity = opts.verbosity ?? "metadata";
    this.redaction = opts.redaction ?? {};
    this.nowFn = opts.now ?? ((): Date => new Date());
  }

  /**
   * Records an event. Unknown fields are stripped, snippets are redacted
   * (or refused wholesale if redaction fails), and the serialized line is
   * defensively checked: a suspected secret-bearing line is downgraded to a
   * metadata-only record with `decision: "audit-suppressed"`.
   */
  record(
    input: Omit<AuditEvent, "ts" | "snippet"> & { snippet?: string },
  ): AuditEvent {
    const event: AuditEvent = {
      ts: this.nowFn().toISOString(),
      kind: input.kind,
      decision: input.decision,
    };
    for (const key of [
      "kind",
      "feature",
      "scope",
      "targetId",
      "degraded",
    ] as const) {
      const value = (input as unknown as Record<string, unknown>)[key];
      if (value !== undefined) {
        (event as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (
      input.byteCounts !== undefined &&
      typeof input.byteCounts === "object"
    ) {
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(input.byteCounts)) {
        if (typeof v === "number") counts[k] = v;
      }
      event.byteCounts = counts;
    }

    if (this.verbosity === "snippets" && typeof input.snippet === "string") {
      const redacted = redactText(input.snippet, this.redaction);
      if (redacted.ok) {
        event.snippet = redacted.content;
      } else {
        // Fail closed: an unclassifiable snippet is never logged.
        event.decision = `${input.decision}; snippet withheld (unclassifiable)`;
      }
    }

    let line = JSON.stringify({
      ts: event.ts,
      ...(event.kind !== undefined ? { kind: event.kind } : {}),
      ...(event.feature !== undefined ? { feature: event.feature } : {}),
      ...(event.scope !== undefined ? { scope: event.scope } : {}),
      ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
      ...(event.byteCounts !== undefined
        ? { byteCounts: event.byteCounts }
        : {}),
      ...(event.degraded !== undefined ? { degraded: event.degraded } : {}),
      decision: event.decision,
      ...(event.snippet !== undefined ? { snippet: event.snippet } : {}),
    });
    if (looksSecretBearing(line)) {
      // Defensive downgrade: never persist a line that still looks secret-bearing.
      line = JSON.stringify({
        ts: event.ts,
        kind: event.kind,
        decision: "audit-suppressed (line failed secret-free post-check)",
      });
      const suppressed: AuditEvent = {
        ts: event.ts,
        kind: event.kind,
        decision: "audit-suppressed (line failed secret-free post-check)",
      };
      this.lines.push(line);
      return suppressed;
    }
    this.lines.push(line);
    return event;
  }

  /** Serialized JSON-line events (queue/log bytes as they would be written). */
  lines_so_far(): readonly string[] {
    return this.lines;
  }
}
