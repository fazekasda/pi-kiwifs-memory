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

/** Q04a: content-free schema bounds for serialized audit identifiers. */
export const AUDIT_LIMITS = {
  /** Max serialized characters for `kind`. */
  kindChars: 64,
  /** Max serialized characters for `feature`/`scope`. */
  identifierChars: 128,
  /** Max serialized characters for `targetId` (safe path-ish identifier). */
  targetIdChars: 256,
  /** Max serialized characters for `decision` reason code. */
  decisionChars: 256,
  /** Max snippet characters BEFORE redaction (post-redaction is shorter). */
  snippetChars: 256,
  /** Byte budget for one serialized JSON line (post-sanitization). */
  maxLineBytes: 2048,
} as const;

/**
 * Safe-charset sanitizer for allowlisted audit identifiers. Strips control
 * characters and anything outside `[A-Za-z0-9._/:@ -]`, and caps length.
 * Content-free by construction: the result can never carry payload bytes,
 * quotes, backslashes or newlines. Returns the cleaned string; the caller
 * compares against the raw value to detect unsafe input.
 */
export function sanitizeAuditIdentifier(raw: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[^A-Za-z0-9._/:@ -]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maxChars);
}

/**
 * Slightly wider safe charset for free-form decision reason codes (which
 * legitimately carry fingerprints like `Error:ECONNREFUSED` and counts).
 */
export function sanitizeAuditDecision(raw: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[^A-Za-z0-9 .:;_/@()~,+-]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maxChars);
}

/**
 * Pure Q04a sanitizer: turns an untrusted record into one schema-allowlisted,
 * length-bounded, secret-free JSON line. Used by both the in-memory
 * `AuditSink` and the durable `FileAuditStore`.
 */
export function buildAuditLine(
  input: Omit<AuditEvent, "ts" | "snippet"> & { snippet?: string },
  opts: { verbosity: AuditVerbosity; redaction: RedactionOptions; now: Date },
): { line: string; event: AuditEvent } {
  const event: AuditEvent = {
    ts: opts.now.toISOString(),
    kind: sanitizeAuditIdentifier(
      String(input.kind ?? ""),
      AUDIT_LIMITS.kindChars,
    ),
    decision: sanitizeAuditDecision(
      String(input.decision ?? ""),
      AUDIT_LIMITS.decisionChars,
    ),
  };
  for (const [key, max] of [
    ["feature", AUDIT_LIMITS.identifierChars],
    ["scope", AUDIT_LIMITS.identifierChars],
    ["targetId", AUDIT_LIMITS.targetIdChars],
  ] as const) {
    const value = (input as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      const raw = String(value);
      const capped = sanitizeAuditIdentifier(raw, max);
      if (capped !== raw) {
        // Unsafe identifier (control chars / off-charset bytes): fail closed
        // per field — the raw value is never persisted; a fixed, content-free
        // marker and reason code replace it.
        (event as unknown as Record<string, unknown>)[key] =
          "(redacted-unsafe)";
        event.decision = `${event.decision}; unsafe:${key}`;
      } else {
        (event as unknown as Record<string, unknown>)[key] = capped;
      }
    }
  }
  if (input.degraded !== undefined) event.degraded = input.degraded === true;
  if (input.byteCounts !== undefined && typeof input.byteCounts === "object") {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.byteCounts)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        const key = sanitizeAuditIdentifier(k, 32);
        if (key.length > 0) counts[key] = Math.max(0, Math.floor(v));
      }
    }
    event.byteCounts = counts;
  }

  if (opts.verbosity === "snippets" && typeof input.snippet === "string") {
    const bounded =
      input.snippet.length > AUDIT_LIMITS.snippetChars
        ? input.snippet.slice(0, AUDIT_LIMITS.snippetChars)
        : input.snippet;
    const redacted = redactText(bounded, opts.redaction);
    if (redacted.ok) {
      event.snippet = redacted.content;
    } else {
      // Fail closed: an unclassifiable snippet is never logged.
      event.decision = `${event.decision}; snippet withheld (unclassifiable)`;
    }
  }

  let line = JSON.stringify({
    ts: event.ts,
    ...(event.kind !== undefined ? { kind: event.kind } : {}),
    ...(event.feature !== undefined ? { feature: event.feature } : {}),
    ...(event.scope !== undefined ? { scope: event.scope } : {}),
    ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
    ...(event.byteCounts !== undefined ? { byteCounts: event.byteCounts } : {}),
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
    event.decision = "audit-suppressed (line failed secret-free post-check)";
    return { line, event };
  }
  // Hard byte bound: a line can still exceed the budget (e.g. many byteCount
  // keys); if so, downgrade to a bounded stub rather than persist oversize.
  if (Buffer.byteLength(line, "utf8") > AUDIT_LIMITS.maxLineBytes) {
    line = JSON.stringify({
      ts: event.ts,
      kind: event.kind,
      decision: "audit-suppressed (line exceeded size bound)",
    });
    event.decision = "audit-suppressed (line exceeded size bound)";
  }
  return { line, event };
}

/**
 * Q04b: structural seam for audit consumers (e.g. the outbox worker). Both
 * the in-memory `AuditSink` and the durable `FileAuditStore` satisfy it, so
 * production composition can swap the sink without per-callsite changes.
 */
export interface AuditSinkLike {
  record(
    input: Omit<AuditEvent, "ts" | "snippet"> & { snippet?: string },
  ): AuditEvent;
}

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
    const { line, event } = buildAuditLine(input, {
      verbosity: this.verbosity,
      redaction: this.redaction,
      now: this.nowFn(),
    });
    this.lines.push(line);
    return event;
  }

  /** Serialized JSON-line events (queue/log bytes as they would be written). */
  lines_so_far(): readonly string[] {
    return this.lines;
  }
}
