/**
 * T07: durable local outbox (architecture.md §2, §6, §13 row 8).
 *
 * The outbox is a JSONL journal (one job per line) in a dedicated directory,
 * guarded by a lock file so two processes cannot interleave writes. Every
 * mutation rewrites the journal atomically (write temp → fsync → rename →
 * fsync dir), so a crash at any point leaves either the previous or the new
 * complete journal — never a torn file. `enqueue` returns only after the job
 * is durably on disk: the opId is persisted BEFORE any side effect
 * (architecture.md §2), and callers may treat a returned job as durably
 * accepted (decisions.md #8).
 *
 * Job shape (§2): {seq, schemaVersion, kind, scope, opId, idempotencyKey,
 * payload(redacted), attempts, nextAttemptAt, createdAt, status}.
 *
 * Overflow / retention (§13 row 8, no drop-oldest):
 * - High-water limits (5,000 jobs / 50 MiB) PAUSE NEW CAPTURE with a visible
 *   coverage gap; pending jobs are never dropped.
 * - Age-based retention (14 days) applies ONLY to acknowledged jobs.
 *
 * Fail-closed properties:
 * - Payloads are defensively screened with `looksSecretBearing` (T06) before
 *   touching queue bytes; a secret-bearing payload refuses to enqueue.
 * - Error strings stored on jobs carry only error name/code — never messages
 *   that could embed user content.
 * - An unknown NEWER schemaVersion puts the outbox into read-only mode with a
 *   visible reason (architecture.md §9); it is never destructively rewritten.
 * - Over-permissive file permissions fail closed on open.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { OpIdNotPersistedError } from "../backend/errors.ts";
import type { IdempotentKind } from "../domain/idempotency.ts";
import { looksSecretBearing } from "../privacy/redaction.ts";

export const OUTBOX_SCHEMA_VERSION = 1;

export type JobStatus = "pending" | "quarantined" | "acked";

export interface OutboxJob {
  readonly seq: number;
  readonly schemaVersion: number;
  readonly kind: IdempotentKind;
  readonly scope: string;
  /** Durable, randomly unique; persisted BEFORE any side effect (§2). */
  readonly opId: string;
  readonly idempotencyKey: string;
  /** Already-redacted payload; screened again on enqueue (defense in depth). */
  readonly payload: unknown;
  attempts: number;
  /** Epoch ms; the worker sends only jobs whose time has come. */
  nextAttemptAt: number;
  readonly createdAt: number;
  status: JobStatus;
  /** Error NAME:CODE only — never a message (no user content in queue bytes). */
  lastError?: string;
  ackedAt?: number;
}

export interface OutboxLimits {
  maxJobs: number;
  maxBytes: number;
  /** Applies to ACKNOWLEDGED jobs only. */
  retentionMs: number;
}

/** §13 row 8 defaults ([P]). */
export const DEFAULT_LIMITS: OutboxLimits = {
  maxJobs: 5000,
  maxBytes: 50 * 1024 * 1024,
  retentionMs: 14 * 24 * 60 * 60 * 1000,
};

export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxError";
  }
}

/** Overflow: capture pauses with a visible coverage gap; pending jobs stay. */
export class OutboxOverflowError extends OutboxError {
  constructor() {
    super(
      "outbox high-water limit reached — new capture paused with a visible coverage gap; pending jobs are preserved, never dropped",
    );
    this.name = "OutboxOverflowError";
  }
}

export class OutboxLockHeldError extends OutboxError {
  constructor(dir: string) {
    super(
      `outbox lock held by another process: ${join(dir, "jobs.jsonl.lock")}`,
    );
    this.name = "OutboxLockHeldError";
  }
}

export class OutboxPermissionError extends OutboxError {
  constructor(path: string, mode: number) {
    super(
      `outbox file has over-permissive mode ${(mode & 0o777).toString(8)} (need 0600 or stricter): ${path}`,
    );
    this.name = "OutboxPermissionError";
  }
}

export class OutboxReadOnlyError extends OutboxError {
  constructor(reason: string) {
    super(`outbox is read-only (fail safe): ${reason}`);
    this.name = "OutboxReadOnlyError";
  }
}

/** Thrown on enqueue when the underlying persist fails (e.g. disk full). */
export class OutboxPersistError extends OutboxError {
  constructor(cause: unknown) {
    const name = cause instanceof Error ? cause.name : "unknown";
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : "";
    super(
      `outbox persist failed (job NOT durably accepted): ${name}${code ? `/${code}` : ""}`,
    );
    this.name = "OutboxPersistError";
  }
}

export interface EnqueueInput {
  kind: IdempotentKind;
  scope: string;
  idempotencyKey: string;
  payload: unknown;
  /**
   * Optional caller-supplied opId (T16 board sends): the payload carries the
   * opId it was built around, so it must be minted by the caller and stored
   * in the SAME durable write — the opId is persisted BEFORE any side
   * effect either way. When omitted the store mints a fresh UUID.
   */
  opId?: string;
}

export interface OutboxStoreOptions {
  limits?: OutboxLimits;
  now?: () => number;
  /** Test hook: when set, persist throws this instead of writing. */
  persistFault?: Error | null;
}

const LOCK_STALE_MS = 30_000;

/**
 * Flushes a directory entry so a just-renamed file survives power loss.
 * Throws on failure (fail closed: durability claim must hold or persist fails).
 */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class DurableOutbox {
  private jobs: OutboxJob[] = [];
  private nextSeq = 1;
  private readonly limits: OutboxLimits;
  private readonly nowFn: () => number;
  /** Test hook: when set, the next persist throws instead of writing. */
  persistFault: Error | null;
  private setReadOnlyReason: string | null = null;
  private readonly dir: string;
  private readonly file: string;
  private readonly tmp: string;
  private readonly lockFile: string;
  private closed = false;

  private constructor(dir: string, opts: OutboxStoreOptions) {
    this.dir = dir;
    this.file = join(dir, "jobs.jsonl");
    this.tmp = join(dir, "jobs.jsonl.tmp");
    this.lockFile = join(dir, "jobs.jsonl.lock");
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.nowFn = opts.now ?? (() => Date.now());
    this.persistFault = opts.persistFault ?? null;
  }

  /**
   * Opens (creating if needed) the outbox directory, acquires the lock file,
   * verifies permissions and loads the journal. Throws on lock contention,
   * over-permissive permissions or a corrupt journal.
   */
  static open(dir: string, opts: OutboxStoreOptions = {}): DurableOutbox {
    const store = new DurableOutbox(dir, opts);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    store.acquireLock();
    try {
      if (existsSync(store.file)) {
        const mode = statSync(store.file).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new OutboxPermissionError(store.file, mode);
        }
        store.load();
      }
    } catch (err) {
      store.releaseLock();
      throw err;
    }
    return store;
  }

  private acquireLock(): void {
    // Stale-lock breakage: a crashed holder leaves the lock behind; after the
    // staleness window another process may take over (multi-process safety).
    try {
      const fd = openSync(this.lockFile, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      closeSync(fd);
      return;
    } catch {
      // falls through to staleness check
    }
    const age = this.nowFn() - statSync(this.lockFile).mtimeMs;
    if (age > LOCK_STALE_MS) {
      rmSync(this.lockFile);
      return this.acquireLock();
    }
    throw new OutboxLockHeldError(this.dir);
  }

  private releaseLock(): void {
    try {
      rmSync(this.lockFile);
    } catch {
      // best effort on teardown
    }
  }

  private load(): void {
    const text = readFileSync(this.file, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new OutboxError(
          `corrupt outbox journal line ${i + 1} (fail closed)`,
        );
      }
      const job = parsed as OutboxJob;
      if (typeof job.seq !== "number" || typeof job.opId !== "string") {
        throw new OutboxError(`malformed outbox job at line ${i + 1}`);
      }
      if (job.schemaVersion > OUTBOX_SCHEMA_VERSION) {
        // Fail safe: unknown newer format is readable-only, never rewritten.
        this.setReadOnlyReason = `journal schemaVersion ${job.schemaVersion} is newer than supported ${OUTBOX_SCHEMA_VERSION}`;
        this.jobs.push(job);
        this.nextSeq = Math.max(this.nextSeq, job.seq + 1);
        continue;
      }
      this.jobs.push(job);
      this.nextSeq = Math.max(this.nextSeq, job.seq + 1);
    }
  }

  get isReadOnly(): boolean {
    return this.setReadOnlyReason !== null;
  }

  get readOnlyReason(): string | null {
    return this.setReadOnlyReason;
  }

  /**
   * Atomically persists the full journal. Returns only after fsync, so a
   * returning enqueue means the job survives crash and power loss.
   */
  private persist(): void {
    if (this.persistFault) {
      // Simulated disk-full / IO failure: nothing has been renamed into place.
      const fault = this.persistFault;
      this.persistFault = null;
      try {
        rmSync(this.tmp, { force: true });
      } catch {
        // ignore
      }
      throw new OutboxPersistError(fault);
    }
    const body = this.jobs
      .filter((j) => j.schemaVersion <= OUTBOX_SCHEMA_VERSION)
      .map((j) => JSON.stringify(j))
      .join("\n");
    const fd = openSync(this.tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmp, this.file);
    fsyncDir(this.dir); // durability: rename survives power loss (§2 claim)
  }

  /** High-water check (§13 row 8). Counts all RETAINED jobs, pending first. */
  get capturePaused(): boolean {
    return (
      this.jobs.length >= this.limits.maxJobs ||
      this.retainedBytes >= this.limits.maxBytes
    );
  }

  get retainedBytes(): number {
    return this.jobs.reduce((n, j) => n + JSON.stringify(j).length + 1, 0);
  }

  get stats(): {
    pending: number;
    quarantined: number;
    acked: number;
    bytes: number;
    paused: boolean;
  } {
    const count = (s: JobStatus) =>
      this.jobs.filter((j) => j.status === s).length;
    return {
      pending: count("pending"),
      quarantined: count("quarantined"),
      acked: count("acked"),
      bytes: this.retainedBytes,
      paused: this.capturePaused,
    };
  }

  /**
   * Persists a sanitized job durably and returns it. The minted opId is on
   * disk BEFORE this call returns — no side effect may precede it (§2).
   * Throws (nothing persisted) on overflow, read-only mode or persist fault;
   * pending jobs and cursors are untouched by a failed enqueue.
   */
  enqueue(input: EnqueueInput): OutboxJob {
    if (this.closed) throw new OutboxError("outbox is closed");
    if (this.setReadOnlyReason)
      throw new OutboxReadOnlyError(this.setReadOnlyReason);
    if (this.capturePaused) throw new OutboxOverflowError();
    // Defense in depth (T06): queue bytes must never contain secret material.
    const serialized = JSON.stringify(input.payload) ?? "";
    if (looksSecretBearing(serialized)) {
      throw new OutboxError(
        "enqueue refused: payload looks secret-bearing (redact before enqueue)",
      );
    }
    if (!/^[0-9a-f]{16,64}$/.test(input.idempotencyKey)) {
      throw new OutboxError(
        "enqueue refused: idempotencyKey must be 16–64 hex chars",
      );
    }
    const job: OutboxJob = {
      seq: this.nextSeq++,
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      kind: input.kind,
      scope: input.scope,
      opId: input.opId ?? randomUUID(),
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      attempts: 0,
      nextAttemptAt: this.nowFn(),
      createdAt: this.nowFn(),
      status: "pending",
    };
    const snapshot = JSON.stringify(this.jobs);
    this.jobs = [...this.jobs, job];
    try {
      this.persist();
    } catch (err) {
      this.jobs = JSON.parse(snapshot) as OutboxJob[]; // job NOT durably accepted
      this.nextSeq = job.seq;
      throw err;
    }
    return job;
  }

  /** Marks a job durably acknowledged (persisted before returning). */
  ack(seq: number): void {
    this.mutate(seq, "ack", (j) => {
      j.status = "acked";
      j.ackedAt = this.nowFn();
    });
  }

  /** Records a transient-failure retry attempt (persisted before returning). */
  retry(seq: number, attempts: number, nextAttemptAt: number): void {
    this.mutate(seq, "retry", (j) => {
      j.attempts = attempts;
      j.nextAttemptAt = nextAttemptAt;
    });
  }

  /** Quarantines a job with an inspectable (name:code-only) reason. */
  quarantine(seq: number, reason: string): void {
    this.mutate(seq, "quarantine", (j) => {
      j.status = "quarantined";
      j.lastError = reason;
    });
  }

  private mutate(seq: number, what: string, fn: (j: OutboxJob) => void): void {
    if (this.setReadOnlyReason)
      throw new OutboxReadOnlyError(this.setReadOnlyReason);
    const job = this.jobs.find((j) => j.seq === seq);
    if (!job || job.schemaVersion > OUTBOX_SCHEMA_VERSION) {
      throw new OutboxError(
        `${what} refused: job ${seq} not found or unsupported schema`,
      );
    }
    // Serialize-based snapshot: fn mutates the job object in place, so an
    // array restore alone would not roll the mutation back.
    const snapshot = JSON.stringify(this.jobs);
    fn(job);
    try {
      this.persist();
    } catch (err) {
      this.jobs = JSON.parse(snapshot) as OutboxJob[];
      throw err;
    }
  }

  /** Explicit user action only: removes one quarantined job. */
  discardQuarantined(seq: number): void {
    const job = this.jobs.find(
      (j) => j.seq === seq && j.status === "quarantined",
    );
    if (!job) throw new OutboxError(`no quarantined job ${seq}`);
    const snapshot = this.jobs;
    this.jobs = this.jobs.filter((j) => j.seq !== seq);
    try {
      this.persist();
    } catch (err) {
      this.jobs = snapshot;
      throw err;
    }
  }

  /** Age-based cleanup — ACKNOWLEDGED jobs only (§13 row 8). */
  runRetention(): number {
    if (this.setReadOnlyReason) return 0;
    const cutoff = this.nowFn() - this.limits.retentionMs;
    const keep = this.jobs.filter(
      (j) => j.status !== "acked" || (j.ackedAt ?? 0) > cutoff,
    );
    const removed = this.jobs.length - keep.length;
    if (removed > 0) {
      const snapshot = this.jobs;
      this.jobs = keep;
      try {
        this.persist();
      } catch (err) {
        this.jobs = snapshot;
        throw err;
      }
    }
    return removed;
  }

  /** All pending jobs, seq order (durable cursor state — local is authoritative). */
  pending(): readonly OutboxJob[] {
    return this.jobs.filter(
      (j) => j.status === "pending" && j.schemaVersion <= OUTBOX_SCHEMA_VERSION,
    );
  }

  quarantined(): readonly OutboxJob[] {
    return this.jobs.filter((j) => j.status === "quarantined");
  }

  hasOpId(opId: string): boolean {
    return this.jobs.some((j) => j.opId === opId);
  }

  /** Highest pending seq (durable local cursor input for pipelines). */
  get maxSeq(): number {
    return this.jobs.reduce((m, j) => Math.max(m, j.seq), 0);
  }

  /**
   * Op-id ledger backed by THIS durable store (T04 `OpIdLedger` contract):
   * `assertPersisted` fails closed unless the opId is in the on-disk journal.
   */
  ledger(): {
    record: (opId: string) => void;
    assertPersisted: (opId: string) => void;
  } {
    return {
      record: (opId: string) => {
        if (!this.hasOpId(opId)) {
          throw new OutboxError(
            `refusing to record opId that is not durably persisted`,
          );
        }
      },
      assertPersisted: (opId: string) => {
        if (!this.hasOpId(opId)) {
          throw new OpIdNotPersistedError(
            "opId was not durably persisted before mutation (refusing side effect)",
          );
        }
      },
    };
  }

  close(): void {
    this.closed = true;
    this.releaseLock();
  }
}
