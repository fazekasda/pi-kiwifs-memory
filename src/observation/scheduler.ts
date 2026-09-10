/**
 * T09: incremental observer scheduling (architecture.md §3.2, decisions.md #6).
 *
 * Responsibilities:
 * - Select UNPROCESSED source entries (Pi message entries not yet consumed in
 *   the coordinator's durable registry and not part of a pending batch) and
 *   schedule bounded extraction batches.
 * - Batching thresholds ([P] §13): extract when unprocessed source ≥ 2,000
 *   tokens or ≥ 10 turns, or after 5 minutes of idle accumulation, whichever
 *   first; batch input/output budgets 6,000/3,000 tokens; pending-batch queue
 *   caps at 20 — excess merges into the oldest-unprocessed ranges, never
 *   silently dropped.
 * - Each source interval is processed once logically: batches are disjoint,
 *   persisted durably (opId + source entries + batch parameters) BEFORE the
 *   model call, and their entries are marked consumed only after the
 *   extraction result is durably accepted into the outbox (decisions.md #8).
 * - Pre-compaction flush (session_before_compact): ONE extraction attempt
 *   bounded by a self-timeout and the event's abort signal. The handler never
 *   returns `cancel`: on timeout/failure compaction proceeds and the
 *   unprocessed ranges remain durably pending with visible status.
 * - The extension's own injected evidence and internal work (custom entries
 *   with the `kiwifs.` prefix) are excluded from recursive capture.
 * - Stale-generation results never touch cursors: every acceptance step
 *   re-checks `coordinator.isCurrent(gen)`.
 *
 * Token accounting uses a conservative char-based estimator (`estimateTokens`).
 * A model-compatible tokenizer (including chat framing) is a hard requirement
 * for the ENFORCED evidence cap (T13); the [P] batching thresholds here are
 * approximations by design and are disclosed as such.
 *
 * Headless/RPC safe: no TUI APIs; failures surface through `pendingStatus()`.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionCoordinator } from "../pi/coordinator.ts";
import type { DurableOutbox } from "../outbox/store.ts";
import { idempotencyKey } from "../domain/idempotency.ts";
import { deriveRecordId } from "../domain/idempotency.ts";
import { memoryRecordPath } from "../domain/paths.ts";
import type { ExclusionRule } from "../privacy/exclusions.ts";
import { createRedactor } from "../privacy/redaction.ts";

/** Extension-owned custom entry prefix — never captured (no recursion). */
export const KIWIFS_CUSTOM_PREFIX = "kiwifs.";

export const OBSERVER_SCHEMA_VERSION = 1;
export const STATE_FILE = "observer-state.json";

/** [P] §3.2 defaults. */
export const DEFAULT_MIN_BATCH_TOKENS = 2_000;
export const DEFAULT_MIN_BATCH_TURNS = 10;
export const DEFAULT_IDLE_MS = 5 * 60_000;
export const DEFAULT_INPUT_BUDGET_TOKENS = 6_000;
export const DEFAULT_OUTPUT_BUDGET_TOKENS = 3_000;
export const DEFAULT_MAX_PENDING_BATCHES = 20;
export const DEFAULT_COMPACT_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Conservative token estimate (~4 chars/token). NOT model-compatible framing;
 * disclosed as an approximation for batching thresholds only (see module doc).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** A candidate source entry as seen by the scheduler. */
export interface SourceEntryView {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface SourceProvider {
  /** Ordered (oldest first) candidate message entries on the active branch. */
  entries(): SourceEntryView[];
}

export type BatchTrigger = "threshold" | "idle" | "manual" | "compact";

export interface ExtractionBatch {
  opId: string;
  trigger: BatchTrigger;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
  /** Redacted source entries, in capture order. */
  sources: { id: string; role: string; text: string }[];
}

export type ExtractFn = (batch: ExtractionBatch) => unknown | Promise<unknown>;

/** T11: emitted after a batch's observation job is durably accepted. */
export interface AcceptedBatchInfo {
  opId: string;
  /** Deterministic observation record id (T05 deriveRecordId). */
  recordId: string;
  /** Deterministic backend path of the observation record. */
  recordPath: string;
  /** The job's durably persisted enqueue time (record `created` basis). */
  createdAt: number;
  sessionId: string;
  branchId?: string;
  sourceEntryIds: string[];
  observations: {
    sourceEntryIds: string[];
    statement: string;
    uncertainty: string;
  }[];
}

export type AcceptedObservationsHook = (info: AcceptedBatchInfo) => void;

export interface PendingBatchRecord {
  opId: string;
  trigger: BatchTrigger;
  entryIds: string[];
  /** Entry ids only; views and redaction are re-derived from the provider at run. */
  createdAt: number;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
  /** Extraction attempts so far (bounded cooldown — T10). */
  attempts?: number;
  /** Earliest wall-clock ms at which a retry may re-run the model call. */
  nextAttemptAt?: number;
}

interface ObserverState {
  schemaVersion: number;
  pendingBatches: PendingBatchRecord[];
}

export interface ObserverSchedulerOptions {
  stateDir: string;
  coordinator: SessionCoordinator;
  outbox: DurableOutbox;
  scope: string;
  sessionId: string;
  branchId?: string;
  /** Optional extraction callback (T10 wires the real model call). */
  extract?: ExtractFn;
  /**
   * T11: called after a batch's observation job is DURABLY accepted into the
   * outbox (never on acceptance failure). Hook errors never fail acceptance —
   * they surface as a visible status note only.
   */
  onAcceptedObservations?: AcceptedObservationsHook;
  /** Compiled exclusion rules; matching entries are never captured. */
  exclusions?: { rule: ExclusionRule; regex?: RegExp }[];
  /** Redactor for the model-call edge (arch §5). Defaults to createRedactor(). */
  redact?: (
    content: string,
  ) => { ok: true; content: string } | { ok: false; reason: string };
  minBatchTokens?: number;
  minBatchTurns?: number;
  idleMs?: number;
  inputBudgetTokens?: number;
  outputBudgetTokens?: number;
  maxPendingBatches?: number;
  compactFlushTimeoutMs?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  /**
   * Q02: live private-mode read at every scheduler boundary (settled, idle,
   * manual, precompact). Fail-closed semantics live in the injected gate
   * (the production runtime passes its shared `LiveConfigPrivateModeGate`).
   * While private: NEW batch creation is refused with a visible skip reason,
   * and unprocessed entries present at a settled/idle/compact boundary are
   * classified private-session (consumed WITHOUT extraction — private-period
   * content is never replayed on resume). Preexisting durably pending
   * batches are retained untouched and resume when normal mode returns.
   */
  isPrivate?: () => boolean;
  now?: () => number;
}

/** Model identity + usage metadata rendered to status (payload-free, T10). */
export interface ModelResultMeta {
  route: string;
  reported?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
  };
}

export interface SettleSummary {
  scheduled: number;
  deferred: boolean;
  retried: number;
  skippedReason?: string;
}

export interface FlushResult {
  flushed: boolean;
  reason?:
    | "no-extractor"
    | "no-candidates"
    | "signal-aborted"
    | "timeout"
    | "extract-failed"
    | "stale-generation"
    | "redaction-held"
    | "accept-failed"
    | "private-mode";
  /** Entries left durably pending (visible coverage gap). */
  pendingEntries: number;
}

/**
 * Adapts Pi session entries (defensively typed) into candidate source views.
 * Skips everything that is not a user/assistant text message, INCLUDING the
 * extension's own injected evidence and internal work: Pi `custom_message`
 * and `custom` entries — in particular every `kiwifs.`-prefixed one — never
 * become capture sources (no recursive capture of our own injections).
 */
export function toSourceViews(entries: readonly unknown[]): SourceEntryView[] {
  const views: SourceEntryView[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e["type"] !== "message") continue;
    if (
      typeof e["customType"] === "string" &&
      e["customType"].startsWith(KIWIFS_CUSTOM_PREFIX)
    ) {
      continue;
    }
    const msg = e["message"] as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;
    const role = msg["role"];
    if (role !== "user" && role !== "assistant") continue;
    const content = msg["content"];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>)["type"] === "text",
        )
        .map((b) => b.text)
        .join("\n");
    }
    if (text.trim() === "") continue;
    views.push({
      id: String(e["id"]),
      role,
      text,
      timestamp: typeof e["timestamp"] === "string" ? e["timestamp"] : "",
    });
  }
  return views;
}

export class ObserverScheduler {
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly coordinator: SessionCoordinator;
  private readonly outbox: DurableOutbox;
  readonly scope: string;
  /** Updated at session_start (session identity is known only there). */
  sessionId: string;
  private branchId: string | undefined;
  private readonly extract: ExtractFn | undefined;
  private readonly onAcceptedObservations: AcceptedObservationsHook | undefined;
  private readonly exclusions: { rule: ExclusionRule; regex?: RegExp }[];
  private readonly redact: (
    content: string,
  ) => { ok: true; content: string } | { ok: false; reason: string };
  private readonly minBatchTokens: number;
  private readonly minBatchTurns: number;
  private readonly idleMs: number;
  readonly inputBudgetTokens: number;
  readonly outputBudgetTokens: number;
  private readonly maxPendingBatches: number;
  private readonly compactFlushTimeoutMs: number;
  private readonly nowFn: () => number;
  /** Per-batch retry cooldown bounds (T10): backoff between model attempts. */
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly isPrivateFn: (() => boolean) | undefined;
  /** Entries classified private-session since startup (metadata count). */
  private privateSkipped = 0;

  private state: ObserverState;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes extraction runs so pending-state mutations never interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Last error (name only) for visible status. */
  lastError: string | undefined;
  /** Last successful extraction's model identity/usage metadata (T10). */
  lastModelInfo: ModelResultMeta | undefined;

  constructor(options: ObserverSchedulerOptions) {
    this.stateDir = options.stateDir;
    this.stateFile = join(this.stateDir, STATE_FILE);
    this.coordinator = options.coordinator;
    this.outbox = options.outbox;
    this.scope = options.scope;
    this.sessionId = options.sessionId;
    this.branchId = options.branchId;
    this.extract = options.extract;
    this.onAcceptedObservations = options.onAcceptedObservations;
    this.exclusions = options.exclusions ?? [];
    // T06 hard default: the real redactor guards the model-call edge.
    this.redact = options.redact ?? createRedactor();
    this.minBatchTokens = options.minBatchTokens ?? DEFAULT_MIN_BATCH_TOKENS;
    this.minBatchTurns = options.minBatchTurns ?? DEFAULT_MIN_BATCH_TURNS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.inputBudgetTokens =
      options.inputBudgetTokens ?? DEFAULT_INPUT_BUDGET_TOKENS;
    this.outputBudgetTokens =
      options.outputBudgetTokens ?? DEFAULT_OUTPUT_BUDGET_TOKENS;
    this.maxPendingBatches =
      options.maxPendingBatches ?? DEFAULT_MAX_PENDING_BATCHES;
    this.compactFlushTimeoutMs =
      options.compactFlushTimeoutMs ?? DEFAULT_COMPACT_FLUSH_TIMEOUT_MS;
    this.nowFn = options.now ?? (() => Date.now());
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
    this.retryCapMs = options.retryCapMs ?? 10 * 60_000;
    this.isPrivateFn = options.isPrivate;
    this.state = this.loadState();
  }

  private privateActive(): boolean {
    return this.isPrivateFn?.() ?? false;
  }

  /**
   * Q02: classifies unprocessed entries captured during private mode as
   * private-session: consumed WITHOUT extraction so resume can never replay
   * them. The dropped coverage is disclosed via pendingStatus — never silent.
   */
  private classifyPrivateSession(candidates: SourceEntryView[]): void {
    this.coordinator.markConsumed(candidates.map((c) => c.id));
    this.privateSkipped += candidates.length;
  }

  // ---- durable state ------------------------------------------------------

  private emptyState(): ObserverState {
    return { schemaVersion: OBSERVER_SCHEMA_VERSION, pendingBatches: [] };
  }

  private loadState(): ObserverState {
    if (!existsSync(this.stateFile)) return this.emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      // Corrupt pending state fails safe to empty: entries re-derive from the
      // coordinator's consumed registry (an entry is never lost — worst case
      // it is re-extracted, which is idempotent by deterministic keys).
      return this.emptyState();
    }
    const s = parsed as Partial<ObserverState>;
    if (
      typeof s !== "object" ||
      s === null ||
      (s.schemaVersion ?? 0) > OBSERVER_SCHEMA_VERSION
    ) {
      // Unknown newer schema: fail safe, never destructively rewrite (§9).
      return this.emptyState();
    }
    const pendingBatches = Array.isArray(s.pendingBatches)
      ? s.pendingBatches.filter(
          (b): b is PendingBatchRecord =>
            typeof b === "object" &&
            b !== null &&
            typeof (b as PendingBatchRecord).opId === "string" &&
            Array.isArray((b as PendingBatchRecord).entryIds),
        )
      : [];
    return { schemaVersion: OBSERVER_SCHEMA_VERSION, pendingBatches };
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    const payload = `${JSON.stringify(this.state)}\n`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.stateFile);
    const dirFd = openSync(this.stateDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  // ---- selection ----------------------------------------------------------

  private excluded(text: string): boolean {
    // Rule dimensions are ANDed (src/privacy/exclusions.ts). Source entries
    // carry no backend path, so a rule with pathPrefix can never fire here.
    for (const { rule, regex } of this.exclusions) {
      if (rule.project !== undefined && rule.project !== this.scope) continue;
      if (rule.pathPrefix !== undefined) continue;
      if (regex !== undefined && !regex.test(text)) continue;
      return true;
    }
    return false;
  }

  /**
   * Entries that still need processing: message text present, not consumed
   * (coordinator registry), not already in a pending batch, not
   * extension-internal, not excluded. Ordered oldest first.
   */
  selectUnprocessed(): SourceEntryView[] {
    const inFlight = new Set<string>(
      this.state.pendingBatches.flatMap((b) => b.entryIds),
    );
    return this.providerEntries().filter((e) => {
      if (e.text.trim() === "") return false;
      if (this.coordinator.isConsumed(e.id)) return false;
      if (inFlight.has(e.id)) return false;
      if (this.excluded(e.text)) return false;
      return true;
    });
  }

  private provider: SourceProvider | undefined;

  /** Injects the session-entry source (index.ts adapts ctx.sessionManager). */
  setProvider(provider: SourceProvider): void {
    this.provider = provider;
  }

  /**
   * Refreshes session/branch identity (T09 follow-up closed in T10): called
   * after `session_tree`/`session_before_fork` re-mint the generation so the
   * idempotency key reflects the branch the batch actually ran on.
   */
  refreshIdentity(sessionId: string, branchId?: string): void {
    this.sessionId = sessionId;
    this.branchId = branchId;
  }

  private providerEntries(): SourceEntryView[] {
    return this.provider?.entries() ?? [];
  }

  private buildBatch(
    candidates: SourceEntryView[],
    trigger: BatchTrigger,
  ): PendingBatchRecord {
    // Accumulate up to the input budget; always at least one entry.
    const entryIds: string[] = [];
    let tokens = 0;
    for (const entry of candidates) {
      const t = estimateTokens(entry.text);
      if (entryIds.length > 0 && tokens + t > this.inputBudgetTokens) break;
      entryIds.push(entry.id);
      tokens += t;
    }
    return {
      opId: randomUUID(),
      trigger,
      entryIds,
      createdAt: this.nowFn(),
      inputBudgetTokens: this.inputBudgetTokens,
      outputBudgetTokens: this.outputBudgetTokens,
    };
  }

  private mergeIntoOldest(batch: PendingBatchRecord): void {
    const oldest = this.state.pendingBatches[0];
    if (!oldest) return;
    const merged = new Set([...oldest.entryIds, ...batch.entryIds]);
    oldest.entryIds = [...merged];
    this.persist();
  }

  // ---- extraction run -----------------------------------------------------

  /**
   * Runs one pending batch: redact → model call → durable outbox acceptance →
   * consume. Serialized on the internal chain. Returns false when the batch
   * remains pending (any failure leaves it durably recorded for re-derivation
   * under the SAME opId — never a duplicate observation).
   */
  private async runBatch(batch: PendingBatchRecord): Promise<boolean> {
    const gen = this.coordinator.generation;
    const byId = new Map(this.providerEntries().map((e) => [e.id, e]));
    const views = batch.entryIds
      .map((id) => byId.get(id))
      .filter((v): v is SourceEntryView => v !== undefined);
    if (views.length === 0) {
      // Source entries no longer exist (e.g. compaction removed them): the
      // interval cannot be processed — consume to prevent a stuck queue.
      this.coordinator.markConsumed(batch.entryIds);
      this.state.pendingBatches = this.state.pendingBatches.filter(
        (b) => b.opId !== batch.opId,
      );
      this.persist();
      return true;
    }
    if (!this.extract) {
      this.lastError = "no-extractor";
      return false;
    }
    // Privacy: redact every source text before the model-call edge. A
    // redaction failure holds the batch (fail closed), never sends raw.
    const sources: ExtractionBatch["sources"] = [];
    for (const v of views) {
      const r = this.redact(v.text);
      if (!r.ok) {
        this.lastError = `redaction-held (${r.reason})`;
        return false;
      }
      sources.push({ id: v.id, role: v.role, text: r.content });
    }
    let result: unknown;
    try {
      result = await this.extract({
        opId: batch.opId,
        trigger: batch.trigger,
        inputBudgetTokens: batch.inputBudgetTokens,
        outputBudgetTokens: batch.outputBudgetTokens,
        sources,
      });
    } catch (err) {
      this.lastError = (err as Error).name;
      this.noteExtractionFailure(batch);
      return false;
    }
    // T10: model identity + usage/cost metadata (visible, payload-free).
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as { model?: unknown }).model === "object"
    ) {
      this.lastModelInfo = (result as { model?: ModelResultMeta }).model;
    }
    // Stale generation: discard the result — the batch stays pending for
    // re-derivation on the new branch/generation.
    if (!this.coordinator.isCurrent(gen)) {
      this.lastError = "stale-generation";
      return false;
    }
    // Durable acceptance BEFORE the cursor advances: the result is persisted
    // as a durable outbox job (redaction re-screened by enqueue itself).
    const key = idempotencyKey({
      kind: "observation",
      scope: this.scope,
      sources: [
        {
          sessionId: this.sessionId,
          ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
          entryIds: batch.entryIds,
        },
      ],
    });
    let enqueuedJob: { createdAt: number } | undefined;
    try {
      enqueuedJob = this.outbox.enqueue({
        kind: "observation",
        scope: this.scope,
        // The job's durable opId IS the batch opId (T19 long-session fix):
        // the batch record was persisted BEFORE the model call under this
        // identity ([P]), crash recovery re-derives under the SAME opId, and
        // the sender validates payload.opId === job.opId — minting a fresh
        // job opId here would quarantine EVERY scheduler-produced
        // observation at delivery (reproduced by the long-session audit).
        opId: batch.opId,
        idempotencyKey: key,
        payload: {
          opId: batch.opId,
          trigger: batch.trigger,
          sessionId: this.sessionId,
          ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
          inputBudgetTokens: batch.inputBudgetTokens,
          outputBudgetTokens: batch.outputBudgetTokens,
          sourceEntryIds: batch.entryIds,
          // The payload carries the observation ARRAY (T19 long-session fix):
          // extractors return an ExtractionResult wrapper ({observations:
          // [...]}) — storing the wrapper instead of the array failed the
          // sender's payload validation and quarantined EVERY
          // scheduler-produced observation at delivery (reproduced by the
          // long-session audit). Array-returning fixtures pass through.
          observations: Array.isArray(result)
            ? result
            : Array.isArray(
                  (result as { observations?: unknown })?.observations,
                )
              ? (result as { observations: unknown[] }).observations
              : result,
        },
      });
    } catch (err) {
      this.lastError = (err as Error).name;
      // Local acceptance failures (outbox persist) do NOT arm the retry
      // cooldown: recovery should re-derive as soon as the local fault
      // clears. The cooldown protects the model provider only.
      return false; // batch stays pending; entries unconsumed
    }
    // Success: reset the retry bookkeeping on the (now consumed) record.
    batch.attempts = 0;
    delete batch.nextAttemptAt;
    this.coordinator.markConsumed(batch.entryIds);
    this.state.pendingBatches = this.state.pendingBatches.filter(
      (b) => b.opId !== batch.opId,
    );
    this.persist();
    // T11: notify the reflection engine — only AFTER durable acceptance, so
    // a hook can never observe an observation that is not durably queued.
    // Hook failures are contained (visible status note; never re-thrown: the
    // batch is already accepted and consumed).
    if (this.onAcceptedObservations) {
      try {
        const recordId = deriveRecordId("observation", batch.opId);
        const createdAt = enqueuedJob?.createdAt ?? Date.now();
        const validated = result as {
          observations?: {
            sourceEntryIds: string[];
            statement: string;
            uncertainty: string;
          }[];
        };
        const observations = Array.isArray(validated?.observations)
          ? validated.observations
          : [];
        const info: AcceptedBatchInfo = {
          opId: batch.opId,
          recordId,
          recordPath: memoryRecordPath(
            this.scope,
            "observation",
            recordId,
            new Date(createdAt),
          ),
          createdAt,
          sessionId: this.sessionId,
          ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
          sourceEntryIds: [...batch.entryIds],
          observations,
        };
        this.onAcceptedObservations(info);
      } catch (err) {
        this.lastError = `reflection-hook (${(err as Error).name})`;
      }
    }
    return true;
  }

  private enqueueRun(batch: PendingBatchRecord): Promise<boolean> {
    const run = this.chain.then(() => this.runBatch(batch));
    // The chain must survive individual failures.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Records a failed extraction attempt and arms the retry cooldown (T10). */
  private noteExtractionFailure(batch: PendingBatchRecord): void {
    batch.attempts = (batch.attempts ?? 0) + 1;
    const backoff = Math.min(
      this.retryCapMs,
      this.retryBaseMs * 2 ** Math.min(batch.attempts - 1, 16),
    );
    batch.nextAttemptAt = this.nowFn() + backoff;
    this.persist();
  }

  /** Re-derives pending batches under their ORIGINAL opIds (crash recovery).
   * Batches inside their retry cooldown are skipped (they stay pending and
   * are retried on a later settle/trigger — never dropped). */
  retryPending(): Promise<number> {
    const now = this.nowFn();
    const batches = this.state.pendingBatches.filter(
      (b) => b.nextAttemptAt === undefined || b.nextAttemptAt <= now,
    );
    for (const b of batches) this.enqueueRun(b);
    return Promise.resolve(batches.length);
  }

  // ---- triggers -----------------------------------------------------------

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.privateActive()) {
        // Transition landed while idle-armed: entries accrued so far are
        // private-period content — classify, never batch.
        const candidates = this.selectUnprocessed();
        if (candidates.length > 0) this.classifyPrivateSession(candidates);
        return;
      }
      const candidates = this.selectUnprocessed();
      if (candidates.length === 0) return;
      this.createAndRun(candidates, "idle");
    }, this.idleMs);
    // Never hold process shutdown open for a batching timer.
    this.idleTimer.unref?.();
  }

  private createAndRun(
    candidates: SourceEntryView[],
    trigger: BatchTrigger,
  ): { scheduled: number; merged: boolean } {
    const batch = this.buildBatch(candidates, trigger);
    if (this.state.pendingBatches.length >= this.maxPendingBatches) {
      // §13 row: excess merges into the oldest-unprocessed range; nothing is
      // silently dropped. The merged batch keeps the oldest opId.
      this.mergeIntoOldest(batch);
      const oldest = this.state.pendingBatches[0];
      if (oldest) this.enqueueRun(oldest);
      return { scheduled: 1, merged: true };
    }
    // Persist (opId + entry list + batch parameters) BEFORE the model call.
    this.state.pendingBatches.push(batch);
    this.persist();
    this.enqueueRun(batch);
    return { scheduled: 1, merged: false };
  }

  /**
   * `agent_settled` trigger (decisions.md #6): check the settled response's
   * coverage and extract when thresholds are met; otherwise arm the idle
   * timer. Repeated triggers over the same coverage never re-extract (AC 1).
   */
  onAgentSettled(): SettleSummary {
    this.clearIdleTimer();
    // Q02: private mode refuses NEW extraction at the settled boundary and
    // classifies unprocessed entries as private-session (never replayed on
    // resume). Preexisting pending batches stay durably untouched.
    if (this.privateActive()) {
      const candidates = this.selectUnprocessed();
      if (candidates.length > 0) this.classifyPrivateSession(candidates);
      return {
        scheduled: 0,
        deferred: false,
        retried: 0,
        skippedReason: "private-mode",
      };
    }
    // Crash recovery first: due pending batches re-run under their original
    // opIds; batches inside their retry cooldown stay pending (T10).
    const now = this.nowFn();
    const retried = this.state.pendingBatches.filter(
      (b) => b.nextAttemptAt === undefined || b.nextAttemptAt <= now,
    ).length;
    void this.retryPending();
    if (!this.extract) {
      return {
        scheduled: 0,
        deferred: false,
        retried,
        skippedReason: "no-extractor",
      };
    }
    const candidates = this.selectUnprocessed();
    if (candidates.length === 0) {
      return { scheduled: 0, deferred: false, retried };
    }
    const tokens = candidates.reduce((s, e) => s + estimateTokens(e.text), 0);
    if (
      tokens < this.minBatchTokens &&
      candidates.length < this.minBatchTurns
    ) {
      // Below threshold: idle batching flushes later (never dropped).
      this.armIdleTimer();
      return { scheduled: 0, deferred: true, retried };
    }
    const { scheduled } = this.createAndRun(candidates, "threshold");
    return { scheduled, deferred: false, retried };
  }

  /** Manual extraction command (T18 wires the UI): flush now, thresholds ignored. */
  extractNow(): SettleSummary {
    this.clearIdleTimer();
    // Q02: a manual flush is still a NEW model call — refused while private
    // (fail closed, visible reason). Entries stay unprocessed; the next
    // settled/compact boundary classifies private-period content, and
    // pre-private entries remain available for extraction after resume.
    if (this.privateActive()) {
      return {
        scheduled: 0,
        deferred: false,
        retried: 0,
        skippedReason: "private-mode",
      };
    }
    const candidates = this.selectUnprocessed();
    if (candidates.length === 0 || !this.extract) {
      return {
        scheduled: 0,
        deferred: false,
        retried: 0,
        skippedReason:
          candidates.length === 0 ? "no-candidates" : "no-extractor",
      };
    }
    const { scheduled } = this.createAndRun(candidates, "manual");
    return { scheduled, deferred: false, retried: 0 };
  }

  /**
   * Pre-compaction flush (§3.2): ONE extraction attempt bounded by a
   * self-timeout AND the event's abort signal. Never returns `cancel` — the
   * caller (index.ts handler) returns normally so compaction always proceeds.
   * On timeout/failure the batch remains durably pending with visible status.
   */
  async onBeforeCompact(signal?: AbortSignal): Promise<FlushResult> {
    const candidates = this.selectUnprocessed();
    // Q02: no model call while private. Entries present at the compaction
    // boundary are classified private-session (compaction may remove them —
    // consuming here is the only way they can never be replayed later).
    if (this.privateActive()) {
      if (candidates.length > 0) this.classifyPrivateSession(candidates);
      return {
        flushed: false,
        reason: "private-mode",
        pendingEntries: this.countPendingBatchEntries(),
      };
    }
    const pendingEntries = candidates.length + this.countPendingBatchEntries();
    if (candidates.length === 0 || !this.extract) {
      return {
        flushed: false,
        reason: this.extract ? "no-candidates" : "no-extractor",
        pendingEntries,
      };
    }
    if (signal?.aborted) {
      return { flushed: false, reason: "signal-aborted", pendingEntries };
    }
    const batch = this.buildBatch(candidates, "compact");
    // Persist before the model call (same durability rule as any batch).
    this.state.pendingBatches.push(batch);
    this.persist();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("compact-flush-timeout")),
        this.compactFlushTimeoutMs,
      );
      // The self-timeout is AUTHORITATIVE (T19 runtime fix, mirrors
      // src/observation/model.ts): ref'd so the bounded reject is guaranteed
      // to fire while the hung extraction is the only pending work. Unbounded
      // hold is impossible either way (bounded by compactFlushTimeoutMs).
    });
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("compact-abort"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const ok = await Promise.race([this.enqueueRun(batch), timeout, abort]);
      if (ok) {
        return {
          flushed: true,
          pendingEntries: this.countPendingBatchEntries(),
        };
      }
      return {
        flushed: false,
        reason: "extract-failed",
        pendingEntries: this.countPendingBatchEntries(),
      };
    } catch (err) {
      this.lastError = (err as Error).message ?? (err as Error).name;
      // The run may still complete later on the chain; whether it does, the
      // durable pending record governs. Entries stay unconsumed either way
      // until acceptance — compaction loses nothing.
      return {
        flushed: false,
        reason:
          (err as Error).message === "compact-abort"
            ? "signal-aborted"
            : "timeout",
        pendingEntries: this.countPendingBatchEntries(),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  }

  countPendingBatchEntries(): number {
    return new Set(this.state.pendingBatches.flatMap((b) => b.entryIds)).size;
  }

  /** Visible pending status (metadata only, never payload content). */
  pendingStatus(): string[] {
    const lines: string[] = [];
    for (const b of this.state.pendingBatches) {
      lines.push(
        `observer: batch ${b.opId.slice(0, 8)} pending (${b.entryIds.length} entries, trigger=${b.trigger}${this.lastError ? `, last=${this.lastError}` : ""})`,
      );
    }
    if (this.outbox.capturePaused) {
      lines.push(
        "observer: outbox high-water reached — capture paused, pending work preserved (visible coverage gap)",
      );
    }
    if (this.privateSkipped > 0) {
      lines.push(
        `observer: ${this.privateSkipped} entries captured during private mode classified private-session — never extracted (visible coverage gap)`,
      );
    }
    if (this.lastModelInfo) {
      const u = this.lastModelInfo.usage;
      lines.push(
        `observer: last extraction via ${this.lastModelInfo.route}` +
          (this.lastModelInfo.reported
            ? ` (reported: ${this.lastModelInfo.reported})`
            : "") +
          (u
            ? ` usage: prompt=${u.promptTokens ?? "?"} completion=${u.completionTokens ?? "?"}` +
              (u.costUsd !== undefined ? ` cost=${u.costUsd}` : "")
            : ""),
      );
    }
    return lines;
  }

  /** Test/inspection: pending batch records (metadata only). */
  get pendingBatches(): readonly PendingBatchRecord[] {
    return this.state.pendingBatches;
  }

  dispose(): void {
    this.clearIdleTimer();
  }
}
