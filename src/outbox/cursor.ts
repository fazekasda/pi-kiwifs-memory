/**
 * T07: durable pipeline cursors and bounded reconciliation
 * (architecture.md §6, §13 row 14).
 *
 * Local state is AUTHORITATIVE: offline startup works entirely from these
 * cursors, with no backend contact. `kiwi_changes` `since`/commit-hash is a
 * reconciliation aid only — on reconnect the feed is checked for drift
 * (another writer advanced or trimmed the feed) and drift is flagged, never
 * adopted blindly. Reconciliation is bounded: ≤ 20 pages / 10,000 changes
 * per pass, then a visible pause that resumes on the next cycle.
 */

import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  writeSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Flushes the directory entry so a just-renamed file survives power loss. */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface CursorState {
  schemaVersion: number;
  /** Highest locally accepted outbox seq — the authoritative cursor. */
  localSeq: number;
  /** Reconciliation aids; advisory only, never trusted over local state. */
  backendLastSeq?: number;
  lastCommitHash?: string;
  /** Visible flag when the feed drifted and coverage must be re-scanned. */
  reconcileNeeded?: boolean;
}

export class CursorFile {
  private state: CursorState;
  private readonly file: string;
  private readonly tmp: string;

  constructor(
    dir: string,
    state: CursorState = { schemaVersion: 1, localSeq: 0 },
  ) {
    this.file = join(dir, "cursors.json");
    this.tmp = join(dir, "cursors.json.tmp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CursorState;
      if (parsed.schemaVersion > state.schemaVersion) {
        // Fail safe read-only on unknown newer versions (architecture.md §9).
        // Retain the parsed AUTHORITATIVE cursor — silently resetting localSeq
        // to 0 could re-feed pipeline ranges. Mark re-scanning needed and
        // never rewrite the newer-format file destructively.
        this.state = { ...parsed, reconcileNeeded: true };
      } else {
        this.state = parsed;
      }
    } else {
      this.state = state;
      this.save();
    }
  }

  get value(): Readonly<CursorState> {
    return this.state;
  }

  private save(): void {
    const fd = openSync(this.tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmp, this.file);
    fsyncDir(dirname(this.file));
  }

  /** Advances the AUTHORITATIVE local cursor (after durable acceptance). */
  advanceLocalSeq(seq: number): void {
    if (seq <= this.state.localSeq) return; // monotonic
    this.state.localSeq = seq;
    this.save();
  }

  /**
   * Records the advisory backend cursor. Only called when the reconciliation
   * pass verified continuity — never adopted blindly.
   */
  setBackend(seq: number, commitHash: string): void {
    this.state.backendLastSeq = seq;
    this.state.lastCommitHash = commitHash;
    this.state.reconcileNeeded = false;
    this.save();
  }

  flagReconcileNeeded(reason: string): void {
    this.state.reconcileNeeded = true;
    void reason; // reason surfaces via status; no payload stored
    this.save();
  }
}

export interface ReconcilePage {
  /** Monotonically increasing backend change seq. */
  changes: { seq: number }[];
  commitHash: string;
  /** True when more pages remain. */
  hasMore: boolean;
}

export type ReconcileFetch = (
  sinceCommitHash: string | undefined,
) => Promise<ReconcilePage>;

export interface ReconcileLimits {
  maxPages: number;
  maxChanges: number;
}

export const DEFAULT_RECONCILE_LIMITS: ReconcileLimits = {
  maxPages: 20,
  maxChanges: 10_000,
};

export interface ReconcileResult {
  pages: number;
  changes: number;
  /** Drift detected: the feed shows a gap or regression — re-scan coverage. */
  drift: boolean;
  /** True when the bound stopped the pass before the feed was caught up. */
  paused: boolean;
}

/**
 * Bounded reconciliation pass (§13 row 14). Never mutates pipeline coverage
 * itself; it only updates the advisory backend cursor or flags drift.
 */
export async function reconcile(
  cursors: CursorFile,
  fetchPage: ReconcileFetch,
  limits: ReconcileLimits = DEFAULT_RECONCILE_LIMITS,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    pages: 0,
    changes: 0,
    drift: false,
    paused: false,
  };
  let since = cursors.value.lastCommitHash;
  let lastSeq = cursors.value.backendLastSeq ?? 0;
  while (result.pages < limits.maxPages && result.changes < limits.maxChanges) {
    const page = await fetchPage(since);
    result.pages += 1;
    result.changes += page.changes.length;
    // Drift: regression OR gap in the feed relative to the advisory cursor.
    // A gap (feed starts past lastSeq + 1 while a prior cursor exists) means
    // changes were lost or trimmed — never adopt a skipped range blindly.
    const first = page.changes[0]?.seq;
    if (page.changes.length > 0 && first !== undefined) {
      if (first <= lastSeq) {
        result.drift = true;
        cursors.flagReconcileNeeded(
          `feed regression at seq ${first} (local advisory ${lastSeq})`,
        );
        return result;
      }
      if (lastSeq > 0 && first > lastSeq + 1) {
        result.drift = true;
        cursors.flagReconcileNeeded(
          `feed gap: ${lastSeq + 1}–${first - 1} missing (advisory ${lastSeq}, feed starts at ${first})`,
        );
        return result;
      }
    }
    if (page.changes.length > 0) {
      lastSeq = page.changes[page.changes.length - 1]!.seq;
    }
    since = page.commitHash;
    if (!page.hasMore) {
      cursors.setBackend(lastSeq, page.commitHash);
      return result;
    }
  }
  result.paused = true; // bound reached: visible pause, resume next cycle
  cursors.flagReconcileNeeded(
    "reconciliation bound reached; coverage re-scan pending",
  );
  return result;
}
