/**
 * T08: Pi session coordinator (architecture.md §3.3, PRD T08).
 *
 * Responsibilities:
 * - Mint a monotonically increasing generation token per (session, active
 *   branch). Generation changes are persisted BEFORE the new generation is
 *   published, so a crash re-mints instead of reusing (crash safety beats
 *   counter continuity — a re-mint only discards stale results).
 * - Reject stale async results: anything carrying an old generation is
 *   discarded, never applied to context or cursors.
 * - Lifecycle init/cleanup at supported boundaries: `session_start`,
 *   `session_before_fork`, `session_before_switch`, `session_before_tree`,
 *   `session_tree`, `session_shutdown` (Pi 0.85.0, docs/research/
 *   mcp-contracts.md §6). Shutdown is idempotent and reentrant.
 * - Shared-ancestor entries are marked consumed per entry ID in a durable
 *   registry, so a fork (new generation, same state dir) never re-captures
 *   shared history.
 * - Cancel stale work: abort controllers registered per generation are
 *   aborted when that generation loses currency (switch/tree/shutdown).
 * - Periodic outbox tick + retention scheduling (T07 follow-up): the worker
 *   ticks on demand only, and retention is pull-only; the coordinator owns
 *   the interval, started at `session_start`, stopped at `session_shutdown`.
 *
 * Headless/RPC safe: the coordinator never touches `ctx.ui`; it only reads
 * `ctx.sessionManager` accessors and `ctx.cwd`.
 */

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

const STATE_SCHEMA_VERSION = 1;
const STATE_FILE = "session-coordinator.json";

/** Session-manager surface the coordinator consumes (ReadonlySessionManager). */
export interface CoordinatorSessionView {
  getSessionId(): string;
  getLeafId(): string | null;
}

/** Minimal handler context: only what the coordinator reads. */
export interface CoordinatorContext {
  cwd: string;
  sessionManager: CoordinatorSessionView;
}

export interface CoordinatorState {
  schemaVersion: number;
  /** Monotonic generation counter (highest minted so far). */
  generation: number;
  sessionId: string | null;
  branchId: string | null;
  /** Entry IDs already captured/consumed; shared across forks. */
  consumedEntries: string[];
}

export interface SessionCoordinatorOptions {
  stateDir: string;
  /** Outbox tick callback (T07 worker). Omitted → no timer is started. */
  onTick?: () => Promise<unknown> | unknown;
  /** Retention callback (T07 pull-only GC). Runs every `retentionEvery` ticks. */
  onRetention?: () => unknown;
  tickIntervalMs?: number;
  retentionEvery?: number;
  /** Optional sink for lifecycle transitions (status output, T08+). */
  onTransition?: (transition: CoordinatorTransition) => void;
}

export interface CoordinatorTransition {
  kind:
    | "session_start"
    | "before_fork"
    | "before_switch"
    | "before_tree"
    | "tree"
    | "shutdown";
  generation: number;
  sessionId: string | null;
  branchId: string | null;
  /** Whether this transition minted a new generation. */
  minted: boolean;
}

export interface StartEvent {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

/** Tracks in-flight async work bound to one generation. */
export interface WorkToken {
  signal: AbortSignal;
  /** Call when the work settles (success, failure or abort). */
  done: () => void;
  readonly aborted: boolean;
}

class AbortedError extends Error {
  constructor() {
    super("work aborted: generation no longer current");
    this.name = "AbortedError";
  }
}

/** Durable state written by a newer extension version: fail closed, never rewrite. */
export class StateSchemaError extends Error {
  constructor(version: number) {
    super(
      `session-coordinator.json schemaVersion ${version} is newer than supported ${STATE_SCHEMA_VERSION} — coordinator disabled (read-only fail-safe)`,
    );
    this.name = "StateSchemaError";
  }
}

export class SessionCoordinator {
  private state: CoordinatorState;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly onTick: (() => Promise<unknown> | unknown) | undefined;
  private readonly onRetention: (() => unknown) | undefined;
  private readonly tickIntervalMs: number;
  private readonly retentionEvery: number;
  private readonly onTransition:
    ((transition: CoordinatorTransition) => void) | undefined;

  /** Generation currently considered current (published). */
  private currentGeneration: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickCount = 0;
  private active = false;
  private readonly work = new Map<number, Set<AbortController>>();
  /** Last seen (oldLeafId, newLeafId) tree pair — duplicate-delivery filter. */
  private lastTree: {
    oldLeafId: string | null;
    newLeafId: string | null;
  } | null = null;
  /**
   * Entry IDs stashed by `before_tree` but not yet committed. Durable
   * consumption is deferred to the `session_tree` handler: `before_tree` is a
   * cancellable hook, so marking consumed there could strand entries in the
   * live branch permanently if navigation is cancelled (invisible coverage
   * gap). Deliberate deviation from architecture §3.3's "marked consumed at
   * before_tree" wording — the safer reading (review T08 B-2).
   */
  private pendingConsumed: string[] = [];

  constructor(options: SessionCoordinatorOptions) {
    this.stateDir = options.stateDir;
    this.stateFile = join(this.stateDir, STATE_FILE);
    this.onTick = options.onTick;
    this.onRetention = options.onRetention;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.retentionEvery = options.retentionEvery ?? 10;
    this.onTransition = options.onTransition;
    this.state = this.loadState();
    this.currentGeneration = this.state.generation;
  }

  // ---- durable state ------------------------------------------------------

  private emptyState(): CoordinatorState {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      generation: 0,
      sessionId: null,
      branchId: null,
      consumedEntries: [],
    };
  }

  private loadState(): CoordinatorState {
    if (!existsSync(this.stateFile)) return this.emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      // Corrupt state fails safe to empty; generations restart from a value
      // higher than any stale result could carry is impossible to guarantee,
      // so a corrupted counter file is treated as a fresh coordinator —
      // stale results from the previous life are discarded because callers
      // hold generations the new coordinator has already passed.
      return this.emptyState();
    }
    const s = parsed as Partial<CoordinatorState>;
    if (
      typeof s !== "object" ||
      s === null ||
      (s.schemaVersion ?? 0) > STATE_SCHEMA_VERSION
    ) {
      // Unknown newer schema: fail closed with a visible error, never
      // destructively rewrite (architecture.md §9).
      throw new StateSchemaError(s.schemaVersion ?? -1);
    }
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      generation:
        typeof s.generation === "number" && Number.isSafeInteger(s.generation)
          ? s.generation
          : 0,
      sessionId: typeof s.sessionId === "string" ? s.sessionId : null,
      branchId: typeof s.branchId === "string" ? s.branchId : null,
      consumedEntries: Array.isArray(s.consumedEntries)
        ? s.consumedEntries.filter((e): e is string => typeof e === "string")
        : [],
    };
  }

  /**
   * Persist state durably (tmp + rename + directory fsync, mirroring
   * src/outbox/cursor.ts). Persistence happens BEFORE the new generation is
   * published, so a crash after persist re-mints a fresh generation.
   */
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

  // ---- read surface -------------------------------------------------------

  get generation(): number {
    return this.currentGeneration;
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  get branchId(): string | null {
    return this.state.branchId;
  }

  /** True when the given generation is still current. */
  isCurrent(generation: number): boolean {
    return generation === this.currentGeneration;
  }

  /**
   * Apply a delayed async result only if its generation is still current.
   * Returns false (and never calls `apply`) for stale results — architecture
   * §3.3: stale results are discarded, never injected.
   */
  applyIfCurrent<T>(
    generation: number,
    apply: (value: T) => void,
    value: T,
  ): boolean {
    if (!this.isCurrent(generation)) return false;
    apply(value);
    return true;
  }

  // ---- work tracking ------------------------------------------------------

  /**
   * Register cancellable work for a generation. The returned token's signal
   * aborts when the generation loses currency (switch/tree/shutdown) or when
   * `done()` is called after invalidation begins.
   */
  registerWork(generation: number): WorkToken {
    const controller = new AbortController();
    let set = this.work.get(generation);
    if (!set) {
      set = new Set();
      this.work.set(generation, set);
    }
    set.add(controller);
    const done = () => {
      set?.delete(controller);
      if (set && set.size === 0) this.work.delete(generation);
    };
    const token: WorkToken = {
      signal: controller.signal,
      done,
      get aborted() {
        return controller.signal.aborted;
      },
    };
    return token;
  }

  /**
   * Fail-fast helper: run `fn` under a generation token. Throws
   * `AbortedError` immediately if the generation is already stale; the token
   * signal lets long-running work observe cancellation.
   */
  runExclusive<T>(
    generation: number,
    fn: (token: WorkToken) => T | Promise<T>,
  ): T | Promise<T> {
    if (!this.isCurrent(generation)) {
      throw new AbortedError();
    }
    const token = this.registerWork(generation);
    const finish = () => token.done();
    let result: T | Promise<T>;
    try {
      result = fn(token);
    } catch (err) {
      finish();
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          finish();
          return v;
        },
        (err) => {
          finish();
          throw err;
        },
      );
    }
    finish();
    return result;
  }

  /** Abort all in-flight work registered for a generation. */
  invalidateWork(generation: number): number {
    const set = this.work.get(generation);
    if (!set) return 0;
    const count = set.size;
    for (const controller of set) controller.abort();
    this.work.delete(generation);
    return count;
  }

  // ---- consumed-entry registry --------------------------------------------

  /** Mark source entry IDs consumed (durable; shared across forks). */
  markConsumed(entryIds: readonly string[]): void {
    let changed = false;
    for (const id of entryIds) {
      if (!this.state.consumedEntries.includes(id)) {
        this.state.consumedEntries.push(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  isConsumed(entryId: string): boolean {
    return this.state.consumedEntries.includes(entryId);
  }

  get consumedCount(): number {
    return this.state.consumedEntries.length;
  }

  // ---- lifecycle ----------------------------------------------------------

  private emit(kind: CoordinatorTransition["kind"], minted: boolean): void {
    this.onTransition?.({
      kind,
      generation: this.currentGeneration,
      sessionId: this.state.sessionId,
      branchId: this.state.branchId,
      minted,
    });
  }

  /** Mint, persist, then publish a new generation. */
  private mint(sessionId: string | null, branchId: string | null): number {
    this.state.generation += 1;
    this.state.sessionId = sessionId;
    this.state.branchId = branchId;
    this.persist();
    this.currentGeneration = this.state.generation;
    return this.currentGeneration;
  }

  private startTimer(): void {
    if (!this.onTick || this.timer || this.tickIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.tickCount += 1;
      try {
        void this.onTick?.();
      } catch {
        // tick must never break the coordinator loop (mirrors worker rule)
      }
      if (
        this.onRetention &&
        this.retentionEvery > 0 &&
        this.tickCount % this.retentionEvery === 0
      ) {
        try {
          this.onRetention();
        } catch {
          // retention failure is visible in the worker, never fatal here
        }
      }
    }, this.tickIntervalMs);
  }

  /**
   * `session_start` handler. Re-initializes from durable state at every
   * supported boundary. A new generation is minted when this is a genuine
   * transition (first start, or a start following `session_shutdown` — which
   * Pi emits before every new/resume/fork — or a different session file).
   * Duplicate delivery of the same start while active is harmless: no
   * re-mint, no state reset.
   */
  onSessionStart(ctx: CoordinatorContext, event: StartEvent): number {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const isNewTransition = !this.active || sessionId !== this.state.sessionId;
    if (isNewTransition) {
      this.mint(sessionId, leafId);
    } else {
      // Duplicate/repeat start for the live session: keep generation.
      // Branch identity still refreshes (leaf may legitimately have moved
      // between the duplicate deliveries via session_tree already handled).
      this.state.sessionId = sessionId;
      this.state.branchId = leafId;
      this.persist();
    }
    this.active = true;
    this.startTimer();
    this.emit("session_start", isNewTransition);
    return this.currentGeneration;
  }

  /**
   * `session_before_fork` handler: snapshot durable cursors/pipelines via
   * the caller-provided hook point (pipelines persist on every write, so the
   * coordinator only records the transition). Never cancels. Generation
   * re-mints at the follow-up `session_start { reason: "fork" }`.
   */
  onBeforeFork(): void {
    this.emit("before_fork", false);
  }

  /**
   * `session_before_switch` handler: cancel in-flight work for the current
   * generation (best-effort; stale results are additionally filtered by the
   * generation check at session_start).
   */
  onBeforeSwitch(): void {
    this.invalidateWork(this.currentGeneration);
    this.emit("before_switch", false);
  }

  /**
   * `session_before_tree` handler. Stashes the shared-ancestor entries from
   * the navigation preparation for consumption in the `session_tree` handler
   * (NOT marked consumed here: `before_tree` is cancellable, and durable
   * consumption before navigation is known to proceed would strand the
   * entries permanently if the navigation never fires). Honors the event's
   * abort signal by stashing nothing when already aborted.
   */
  onBeforeTree(
    preparation?: { entriesToSummarize?: readonly { id: string }[] },
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted) return;
    this.pendingConsumed = (preparation?.entriesToSummarize ?? []).map(
      (e) => e.id,
    );
    this.emit("before_tree", false);
  }

  /**
   * `session_tree` handler: branch navigation completed. Commits the entries
   * stashed at `before_tree` (navigation actually proceeded), then re-mints
   * the generation for the new branch.
   *
   * Duplicate-delivery filter uses the `(oldLeafId, newLeafId)` pair, not the
   * leaf alone: Pi appends messages without emitting `session_tree`, so the
   * leaf at mint time (branchId) can be re-visited later (navigate back to
   * the recorded leaf) — that is a genuine navigation and MUST re-mint and
   * invalidate in-flight work, whereas duplicates replay the identical pair.
   * (Review T08 B-1.)
   */
  onTree(
    ctx: CoordinatorContext,
    oldLeafId: string | null,
    newLeafId: string | null,
  ): number {
    if (!this.active) {
      // Tree event without a start (defensive): initialize like a start.
      return this.onSessionStart(ctx, { reason: "startup" });
    }
    const duplicate =
      this.lastTree !== null &&
      this.lastTree.oldLeafId === oldLeafId &&
      this.lastTree.newLeafId === newLeafId;
    this.lastTree = { oldLeafId, newLeafId };
    if (this.pendingConsumed.length > 0) {
      // Commit-once dedup is handled by markConsumed itself.
      this.markConsumed(this.pendingConsumed);
      this.pendingConsumed = [];
    }
    this.invalidateWork(this.currentGeneration);
    if (!duplicate && oldLeafId !== newLeafId) {
      this.mint(ctx.sessionManager.getSessionId(), newLeafId);
      this.emit("tree", true);
    } else {
      this.emit("tree", false);
    }
    return this.currentGeneration;
  }

  /**
   * `session_shutdown` handler: idempotent teardown — stop the tick timer,
   * abort in-flight work, flush durable state, mark inactive so the next
   * start re-mints. Repeat delivery is harmless.
   */
  onShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Navigation never completed: entries stay unconsumed (recapture is
    // safe and preferred over a permanent, invisible coverage gap).
    this.pendingConsumed = [];
    this.invalidateWork(this.currentGeneration);
    this.active = false;
    this.persist();
    this.emit("shutdown", false);
  }

  /** Test/inspection surface: whether the timer is running. */
  get timerRunning(): boolean {
    return this.timer !== undefined;
  }
}

/** Extracted for reuse: AbortedError is thrown by runExclusive. */
export { AbortedError as GenerationAbortedError };
