/**
 * T18: shared-consumer safety for board delivery (T17 follow-up).
 *
 * T17's documented single-instance assumption ("one state file is written
 * by one process at a time; concurrent sessions sharing the SAME
 * consumerId would last-write-wins over each other's durable entries") is
 * now ENFORCED, not merely documented: a `delivery-<consumerId>.lock` file
 * holding the owning pid must be acquired before any delivery poller starts.
 * A second writer is REFUSED VISIBLY (delivery held with a reason naming the
 * holder) — it never silently shares, overwrites, or drops durable cursor
 * state.
 *
 * Design:
 * - O_EXCL create (`wx`) makes acquisition atomic; the file content is the
 *   owning pid (+ start time marker), 0o600, next to the state file.
 * - Stale detection: if the recorded pid is not alive (or is our own pid
 *   from a previous crashed generation we can safely reclaim), the lock is
 *   broken and reclaimed. A live foreign pid holds the lock — fail closed.
 * - Release deletes the file. On process crash the file remains; the next
 *   starter's pid liveness check reclaims it (no watchdog needed).
 * - Acquisition is re-check-then-take: between `exists` and `wx` create the
 *   winner is decided by the kernel (only one `wx` create succeeds).
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const LOCK_STALE_MS = 12 * 60 * 60 * 1000; // belt-and-braces age bound

export class ConsumerLockError extends Error {
  readonly holderPid: number | undefined;
  constructor(message: string, holderPid: number | undefined) {
    super(message);
    this.name = "ConsumerLockError";
    this.holderPid = holderPid;
  }
}

export interface ConsumerLock {
  readonly path: string;
  release(): void;
}

/** Liveness of a pid (ESRCH/EPERM distinction is irrelevant here: both mean "not provably dead" is only EPERM — treat EPERM as alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPath(stateDir: string, consumerId: string): string {
  // consumerId is grammar-validated upstream ([a-z0-9][a-z0-9_-]{0,63});
  // defensively reject anything else before it touches a filename.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(consumerId)) {
    throw new ConsumerLockError(`invalid consumerId: ${consumerId}`, undefined);
  }
  return join(stateDir, `delivery-${consumerId}.lock`);
}

function readHolderPid(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const m = /^pid=(\d+)(?:\s|$)/.exec(raw);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquires the exclusive consumer lock or throws `ConsumerLockError` with a
 * visible, actionable reason. Safe against concurrent acquirers: the O_EXCL
 * create is the single serialization point.
 */
export function acquireConsumerLock(
  stateDir: string,
  consumerId: string,
  now: number = Date.now(),
): ConsumerLock {
  const path = lockPath(stateDir, consumerId);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ConsumerLockError(
          `consumer lock unusable (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`,
          undefined,
        );
      }
      // Held by someone. Decide stale vs live.
      const pid = readHolderPid(path);
      const age = now - (existsSync(path) ? statMtimeMs(path) : 0);
      // NOTE: pid === process.pid is NOT stale — a leaked lock from an
      // earlier runtime in this same process still means a possible
      // co-writer (fail closed, refuse).
      const stale = pid === undefined || !pidAlive(pid) || age > LOCK_STALE_MS;
      if (!stale) {
        throw new ConsumerLockError(
          `board consumer "${consumerId}" is already held by pid ${pid ?? "?"} — ` +
            "another live session owns this consumerId; use a distinct board.consumerId per session (shared cursors are not safe)",
          pid,
        );
      }
      // Break the stale lock: unlink then retry the O_EXCL create.
      try {
        unlinkSync(path);
      } catch {
        /* someone else reclaimed it; retry decides */
      }
      continue;
    }
    // We own fd on a fresh file. Write the pid durably enough for liveness
    // checks (small file, no fsync needed for correctness: a torn/empty file
    // reads as pid=undefined → stale-reclaimable, never a false refusal).
    try {
      writeSync(fd, `pid=${process.pid} started=${now}\n`);
    } finally {
      closeSync(fd);
    }
    return { path, release: () => safeUnlink(path) };
  }
  throw new ConsumerLockError(
    `consumer lock for "${consumerId}" could not be reclaimed after stale break`,
    undefined,
  );
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone — release is idempotent */
  }
}

/** Test helper: atomically replace the lock content (simulates a crashed owner). */
export function writeLockFileForTest(
  stateDir: string,
  consumerId: string,
  pid: number,
): string {
  const path = lockPath(stateDir, consumerId);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `pid=${pid} started=0\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}
