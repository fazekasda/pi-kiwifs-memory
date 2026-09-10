/**
 * T07: outbox worker (architecture.md §6, §12 fault matrix).
 *
 * - Per-scope ordered delivery: within a scope, jobs are sent strictly in seq
 *   order (a not-yet-due or failing head blocks later same-scope jobs);
 *   different scopes proceed independently.
 * - Capped exponential backoff with jitter for transient (availability)
 *   failures; permanent failures (non-retryable codes, or attempts exhausted)
 *   are quarantined — inspectable, bounded, never retried, never blocking.
 * - Private mode (T06): before every send the worker checks the gate; held
 *   jobs are never dropped. The release listener is registered AT
 *   CONSTRUCTION — before the gate can ever be enabled (hard requirement,
 *   docs/privacy.md) — so `resume()` always reaches the worker.
 * - Failed jobs never block Pi interaction: `tick` never throws.
 * - Acks happen only AFTER the sender resolves; a crash between remote
 *   success and local ack replays the job, and deterministic-path
 *   idempotency (B2) makes that replay a no-op on the backend.
 */

import { isRetryable } from "../backend/errors.ts";
import type { AuditSinkLike } from "../privacy/audit.ts";
import {
  PrivateModeActiveError,
  type PrivateModeGateAdapter,
} from "../privacy/private-mode.ts";
import type { OutboxJob } from "./store.ts";
import type { DurableOutbox } from "./store.ts";

/**
 * Sends one job's payload to the backend. Throws on failure.
 * The optional signal is the worker's best-effort in-flight cancellation
 * (private-mode transition): supporting senders propagate it to the transport
 * so an in-flight HTTP request is aborted. Sent bytes cannot be recalled.
 */
export type JobSender = (job: OutboxJob, signal?: AbortSignal) => Promise<void>;

export interface OutboxWorkerOptions {
  store: DurableOutbox;
  send: JobSender;
  gate?: PrivateModeGateAdapter;
  audit?: AuditSinkLike;
  maxAttempts?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}

export interface TickSummary {
  sent: string[];
  /** Remote accepted but local ack persist failed — job stays pending for a safe replay. */
  pendingAck: string[];
  retried: { opId: string; attempts: number; nextAttemptAt: number }[];
  quarantined: { opId: string; reason: string }[];
  held: string[];
}

/** Error fingerprint for durable storage: name:code only, never a message. */
export function errorFingerprint(err: unknown): string {
  if (err instanceof Error) {
    const code =
      typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code ? `${err.name}:${code}` : err.name;
  }
  return "unknown";
}

export class OutboxWorker {
  private readonly store: DurableOutbox;
  private readonly send: JobSender;
  private readonly gate: PrivateModeGateAdapter | undefined;
  private readonly audit: AuditSinkLike | undefined;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly capDelayMs: number;
  private readonly jitterRatio: number;
  private readonly nowFn: () => number;
  private readonly random: () => number;
  readonly opIdLedger: {
    record: (opId: string) => void;
    assertPersisted: (opId: string) => void;
  };

  constructor(opts: OutboxWorkerOptions) {
    this.store = opts.store;
    this.send = opts.send;
    this.gate = opts.gate;
    this.audit = opts.audit;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.capDelayMs = opts.capDelayMs ?? 60_000;
    this.jitterRatio = opts.jitterRatio ?? 0.2;
    this.nowFn = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => Math.random());
    // Durable op-id ledger: only opIds present in the on-disk journal pass.
    this.opIdLedger = opts.store.ledger();
    // HARD REQUIREMENT (docs/privacy.md): register the release listener
    // before the gate can ever be enabled, so a resume always reaches us.
    if (this.gate) {
      this.gate.onRelease(() => {
        // Q04b: sanitized transition audit — a release is a metadata-only
        // event (no opIds, no reasons beyond the fixed code).
        this.audit?.record({
          kind: "outbox",
          decision: "released (private mode)",
        });
        void this.tick();
      });
      // Best-effort in-flight cancellation (Q02): a normal→private
      // transition aborts the request currently being delivered. Sent bytes
      // cannot be recalled; the aborted job is HELD (never dropped, never
      // quarantined) and resumes after an explicit resume().
      this.gate.onCancel?.(() => {
        this.activeSend?.abort();
      });
    }
  }

  /** Controller for the one delivery currently in flight, if any. */
  private activeSend: AbortController | undefined;

  /** Backoff = min(cap, base * 2^(attempts-1)) scaled by [1, 1+jitter]. */
  backoffMs(attempts: number): number {
    const raw = Math.min(
      this.capDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, attempts - 1),
    );
    return Math.round(raw * (1 + this.jitterRatio * this.random()));
  }

  /**
   * Processes at most one due job per scope, in seq order within each scope.
   * Never throws — failed jobs must never block ordinary Pi interaction.
   */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      sent: [],
      pendingAck: [],
      retried: [],
      quarantined: [],
      held: [],
    };
    const now = this.nowFn();
    // Per-scope head = lowest-seq PENDING job, regardless of due time: a
    // later job never overtakes an earlier same-scope job that is still in
    // backoff (strict per-scope ordering, architecture.md §6).
    const byScope = new Map<string, OutboxJob>();
    for (const job of this.store.pending()) {
      const head = byScope.get(job.scope);
      if (!head || job.seq < head.seq) byScope.set(job.scope, job);
    }
    for (const job of byScope.values()) {
      if (job.nextAttemptAt > now) continue; // head not due yet → scope waits
      // Private mode: hold (never send, never drop). assertNetworkAllowed is
      // a second, independent check on the same gate before touching network.
      if (this.gate?.isPrivate) {
        this.gate.holdWhilePrivate({ opId: job.opId, kind: job.kind });
        // Q04b: sanitized private-transition audit (metadata only).
        this.audit?.record({
          kind: "outbox",
          feature: job.kind,
          scope: job.scope,
          decision: "held (private mode)",
        });
        summary.held.push(job.opId);
        continue;
      }
      await this.deliver(job, summary);
    }
    return summary;
  }

  private async deliver(job: OutboxJob, summary: TickSummary): Promise<void> {
    // Best-effort cancel seam: armed for the duration of THIS delivery so a
    // transition-time onCancel aborts the in-flight request through the
    // sender's signal (where the sender/transport supports it).
    const controller = new AbortController();
    this.activeSend = controller;
    try {
      if (this.gate) this.gate.assertNetworkAllowed("network");
      // The opId was durably persisted at enqueue; re-assert before the side
      // effect so no sender can mutate under an unpersisted identity.
      this.opIdLedger.assertPersisted(job.opId);
      await this.send(job, controller.signal);
      summary.sent.push(job.opId);
      this.audit?.record({
        kind: "outbox",
        feature: job.kind,
        scope: job.scope,
        decision: "sent",
      });
      // Crash window: remote success BEFORE local ack. If the ack persist
      // fails the job deliberately stays pending — the replay is a no-op on
      // the backend (deterministic paths, B2); never a false completeness
      // claim and never a quarantine (nothing failed on the backend).
      try {
        this.store.ack(job.seq);
      } catch {
        summary.pendingAck.push(job.opId);
      }
    } catch (err) {
      // Transition landed mid-send (the abort surfaced as a CancelledError
      // or any other failure): fail CLOSED — hold, never retry/quarantine.
      if (this.gate?.isPrivate) {
        this.gate.holdWhilePrivate({ opId: job.opId, kind: job.kind });
        this.audit?.record({
          kind: "outbox",
          feature: job.kind,
          scope: job.scope,
          decision: "held (private mode)",
        });
        summary.held.push(job.opId);
        return;
      }
      if (err instanceof PrivateModeActiveError) {
        this.gate?.holdWhilePrivate({ opId: job.opId, kind: job.kind });
        this.audit?.record({
          kind: "outbox",
          feature: job.kind,
          scope: job.scope,
          decision: "held (private mode)",
        });
        summary.held.push(job.opId);
        return;
      }
      const fingerprint = errorFingerprint(err);
      const willRetry = isRetryable(err) && job.attempts + 1 < this.maxAttempts;
      // Persisting the retry/quarantine state must never throw out of tick
      // (e.g. disk full while recording a failure): the job simply stays
      // pending and will be retried on a later tick. Failed jobs must never
      // block ordinary Pi interaction.
      try {
        if (willRetry) {
          const attempts = job.attempts + 1;
          const nextAttemptAt = this.nowFn() + this.backoffMs(attempts);
          this.store.retry(job.seq, attempts, nextAttemptAt);
          summary.retried.push({ opId: job.opId, attempts, nextAttemptAt });
          this.audit?.record({
            kind: "outbox",
            feature: job.kind,
            scope: job.scope,
            decision: `retry ${attempts}/${this.maxAttempts} (${fingerprint})`,
            degraded: true,
          });
        } else {
          const reason = `quarantined after ${job.attempts + 1} attempt(s): ${fingerprint}`;
          this.store.quarantine(job.seq, reason);
          summary.quarantined.push({ opId: job.opId, reason });
          this.audit?.record({
            kind: "outbox",
            feature: job.kind,
            scope: job.scope,
            decision: `quarantined (${fingerprint})`,
            degraded: true,
          });
        }
      } catch {
        // Persist fault while recording the failure — job stays pending.
      }
    } finally {
      if (this.activeSend === controller) this.activeSend = undefined;
    }
  }
}
