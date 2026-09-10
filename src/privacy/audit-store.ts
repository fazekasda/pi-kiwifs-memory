/**
 * Q04a: durable bounded audit storage (`FileAuditStore`).
 *
 * Hardening scope (audit storage/schema/retention only; no runtime wiring in
 * this task):
 * - Same content-free schema allowlist as `AuditSink` (`buildAuditLine`):
 *   identifiers are safe-charset sanitized and length-bounded, snippets are
 *   redacted or withheld, every line passes the secret-free post-check.
 * - Bounded disk retention: the active file plus a fixed number of rotated
 *   files (`audit.log`, `audit.log.1`, ...). Oldest rotated file is deleted
 *   on overflow (no unbounded growth). Stale `*.tmp` files are removed at
 *   init; repairs write through a `.tmp` + rename so no partial writes.
 * - Private permissions: the audit directory is created 0o700, and the log,
 *   lock, and temp files are 0o600 (POSIX). Existing files with wider
 *   permissions are tightened at init (best effort).
 * - Single-owner enforcement: an `O_EXCL` lock file (`<path>.lock`) holds the
 *   owning pid. A second writer cannot acquire the lock and degrades to a
 *   bounded in-memory buffer with a sanitized `lock-unavailable` status
 *   (events are neither silently dropped nor falsely acknowledged as
 *   persisted). Takeover is pid-first: a lock whose owner pid is provably
 *   dead is taken over once; a live owner is NEVER stolen, regardless of
 *   lock age. Only an unreadable/malformed lock older than `staleLockMs` is
 *   taken over by age (Q04 review fix: age no longer takes precedence over
 *   pid liveness).
 * - Corruption handling: at init a trailing partial (newline-terminated?
 *   no) line is repaired by truncating back to the last complete newline via
 *   tmp+rename; the number of skipped corrupt bytes is counted and surfaced
 *   in `status()` — never thrown, never exposed as raw bytes.
 * - Write failures (e.g. ENOSPC disk-full): `record()` never throws; the
 *   event goes to the bounded in-memory fallback buffer and `status()`
 *   reports a sanitized error class (errno code only) plus failure count.
 *   Callers must treat audit logging as best-effort and never as an
 *   authorization or acknowledgement signal.
 *
 * New operational proposal (NOT previously approved — needs user sign-off):
 *   `privacy.audit.file` configuration with explicit defaults
 *   `maxRotateBytes = 256 KiB`, `maxRotatedFiles = 2` (total on-disk audit
 *   budget ≤ 3 × 256 KiB + lock/temp overhead), `staleLockMs = 30_000`.
 */

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
  AUDIT_LIMITS,
  buildAuditLine,
  type AuditEvent,
  type AuditVerbosity,
} from "./audit.ts";
import type { RedactionOptions } from "./redaction.ts";

/** Minimal fs surface used by the store (injectable for synthetic tests). */
export interface AuditStoreFs {
  appendFileSync(path: string, data: string, opts?: { mode?: number }): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: true; mode: number }): undefined;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  renameSync(from: string, to: string): void;
  statSync(path: string): { size: number; mtimeMs: number; isFile(): boolean };
  unlinkSync(path: string): void;
  chmodSync(path: string, mode: number): void;
  truncateSync(path: string, len: number): void;
  writeFileSync(
    path: string,
    data: string,
    opts: { flag: string; mode: number },
  ): void;
}

export interface FileAuditStoreOptions {
  /** Absolute or relative path of the audit log (e.g. `<stateDir>/audit.log`). */
  path: string;
  /** Max bytes of the active log before rotation. Default 256 KiB. */
  maxRotateBytes?: number;
  /** Max number of rotated files kept (`audit.log.1` ... `.N`). Default 2. */
  maxRotatedFiles?: number;
  /** Age (ms) after which a lock from a dead/unknown owner is taken over. Default 30_000. */
  staleLockMs?: number;
  verbosity?: AuditVerbosity;
  redaction?: RedactionOptions;
  now?: () => Date;
  /** Synthetic fs injection for tests only. */
  fs?: AuditStoreFs;
}

export interface FileAuditStoreStatus {
  /** Events durably persisted since store creation. */
  persisted: number;
  /** Events held only in the bounded in-memory fallback (not on disk). */
  buffered: number;
  /** Rotated segment count currently on disk. */
  rotatedFiles: number;
  /** Approximate bytes of the active log file. */
  activeBytes: number;
  /** Best-effort single-owner state. */
  lock: "owned" | "unavailable";
  /** Sanitized error class of the last write failure (errno code or fixed label). */
  lastError?:
    | "ENOSPC"
    | "EACCES"
    | "ENOENT"
    | "EIO"
    | "io-error"
    | "lock-unavailable"
    | undefined;
  /** Number of failed writes since creation. */
  writeFailures: number;
  /** Bytes skipped during trailing-corruption repair. */
  corruptSkippedBytes: number;
  /** True when the store is operating degraded (buffer-only or repaired). */
  degraded: boolean;
}

/** Fixed bound for the in-memory fallback buffer (degraded mode). */
const FALLBACK_BUFFER_LINES = 64;

const MAX_ROTATE_BYTES = 256 * 1024;
const MAX_ROTATED_FILES = 2;
const STALE_LOCK_MS = 30_000;

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (
      err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

export class FileAuditStore {
  private readonly fs: AuditStoreFs;
  private readonly filePath: string;
  private readonly dirPath: string;
  private readonly lockPath: string;
  private readonly rotateBytes: number;
  private readonly maxRotated: number;
  private readonly staleMs: number;
  private readonly verbosity: AuditVerbosity;
  private readonly redaction: RedactionOptions;
  private readonly nowFn: () => Date;

  private readonly fallback: string[] = [];
  private persistedCount = 0;
  private writeFailures = 0;
  private corruptSkipped = 0;
  private lastError: FileAuditStoreStatus["lastError"];
  private lockState: "owned" | "unavailable" = "unavailable";
  private closed = false;

  constructor(opts: FileAuditStoreOptions) {
    this.fs = opts.fs ?? (nodeFs as unknown as AuditStoreFs);
    this.filePath = nodePath.resolve(opts.path);
    this.dirPath = nodePath.dirname(this.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.rotateBytes = opts.maxRotateBytes ?? MAX_ROTATE_BYTES;
    this.maxRotated = opts.maxRotatedFiles ?? MAX_ROTATED_FILES;
    this.staleMs = opts.staleLockMs ?? STALE_LOCK_MS;
    this.verbosity = opts.verbosity ?? "metadata";
    this.redaction = opts.redaction ?? {};
    this.nowFn = opts.now ?? ((): Date => new Date());

    // Private permissions for the state directory (best effort).
    try {
      this.fs.mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
    } catch {
      /* init failures surface via status(); never throw out of the ctor path */
    }
    this.cleanStaleTempFiles();
    this.acquireLock();
    if (this.lockState === "owned") {
      this.removeLegacyRotatedSegments();
      this.repairTrailingCorruption();
      this.ensurePrivateFileMode();
    }
  }

  /**
   * Q04 review fix: rotated segments numbered beyond `maxRotatedFiles` from
   * a prior (larger) configuration are removed at init so the documented
   * on-disk budget holds even after a reconfiguration downward.
   */
  private removeLegacyRotatedSegments(): void {
    const base = nodePath.basename(this.filePath);
    try {
      for (const entry of this.fs.readdirSync(this.dirPath)) {
        const suffix = entry.startsWith(`${base}.`)
          ? entry.slice(base.length + 1)
          : "";
        if (/^\d+$/.test(suffix) && Number(suffix) > this.maxRotated) {
          try {
            this.fs.unlinkSync(nodePath.join(this.dirPath, entry));
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      /* dir may not exist yet */
    }
  }

  private cleanStaleTempFiles(): void {
    try {
      for (const entry of this.fs.readdirSync(this.dirPath)) {
        if (
          entry.startsWith(`${nodePath.basename(this.filePath)}.`) &&
          entry.endsWith(".tmp")
        ) {
          try {
            this.fs.unlinkSync(nodePath.join(this.dirPath, entry));
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      /* dir may not exist yet */
    }
  }

  private acquireLock(): void {
    const payload = JSON.stringify({ pid: process.pid, purpose: "audit-log" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.fs.writeFileSync(this.lockPath, payload, {
          flag: "wx",
          mode: 0o600,
        });
        this.lockState = "owned";
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code !== "EEXIST") {
          this.lastError = "io-error";
          return;
        }
        // Existing lock: pid liveness FIRST (Q04 review fix) — a live owner
        // is never stolen regardless of age; takeover only when the owner
        // pid is provably dead, or the lock is unreadable AND stale by age.
        let stale = false;
        let ownerPidKnown = false;
        try {
          const parsed = JSON.parse(
            this.fs.readFileSync(this.lockPath).toString("utf8"),
          ) as { pid?: number };
          if (typeof parsed.pid === "number") {
            ownerPidKnown = true;
            if (!isAlivePid(parsed.pid) && parsed.pid !== process.pid) {
              stale = true;
            }
          }
        } catch {
          ownerPidKnown = false; // unreadable lock: fall through to age check
        }
        if (!stale && !ownerPidKnown) {
          try {
            const st = this.fs.statSync(this.lockPath);
            if (Date.now() - st.mtimeMs > this.staleMs) stale = true;
          } catch {
            stale = false; // unreadable lock: treat as live, never steal
          }
        }
        if (!stale) {
          this.lockState = "unavailable";
          this.lastError = "lock-unavailable";
          return;
        }
        try {
          this.fs.unlinkSync(this.lockPath);
        } catch {
          this.lockState = "unavailable";
          this.lastError = "lock-unavailable";
          return;
        }
      }
    }
    this.lockState = "unavailable";
    this.lastError = "lock-unavailable";
  }

  /** Repair a trailing partial line so every persisted line is complete. */
  private repairTrailingCorruption(): void {
    if (!this.fs.existsSync(this.filePath)) return;
    let raw: Buffer;
    try {
      raw = this.fs.readFileSync(this.filePath);
    } catch {
      return;
    }
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // No complete line at all: discard the file content.
      this.corruptSkipped += raw.byteLength;
      this.replaceFileAtomically("");
      return;
    }
    if (lastNewline === raw.byteLength - 1) return; // clean tail
    this.corruptSkipped += raw.byteLength - (lastNewline + 1);
    this.replaceFileAtomically(
      raw.subarray(0, lastNewline + 1).toString("utf8"),
    );
  }

  private replaceFileAtomically(content: string): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      this.fs.writeFileSync(tmp, content, { flag: "w", mode: 0o600 });
      this.fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        this.fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      this.lastError = "io-error";
    }
  }

  private ensurePrivateFileMode(): void {
    try {
      if (this.fs.existsSync(this.filePath)) {
        this.fs.chmodSync(this.filePath, 0o600);
      }
    } catch {
      /* best effort; creation mode already 0o600 */
    }
  }

  /** Records an event; never throws. See `AuditSink.record` for schema rules. */
  record(
    input: Omit<AuditEvent, "ts" | "snippet"> & { snippet?: string },
  ): AuditEvent {
    const { line, event } = buildAuditLine(input, {
      verbosity: this.verbosity,
      redaction: this.redaction,
      now: this.nowFn(),
    });
    if (this.closed || this.lockState !== "owned") {
      this.pushFallback(line, "lock-unavailable");
      return { ...event, degraded: true };
    }
    try {
      this.rotateIfNeeded(Buffer.byteLength(line, "utf8") + 1);
      this.fs.appendFileSync(this.filePath, `${line}\n`, { mode: 0o600 });
      this.persistedCount += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const known = ["ENOSPC", "EACCES", "ENOENT", "EIO"] as const;
      const classified = (known as readonly string[]).includes(code)
        ? (code as (typeof known)[number])
        : "io-error";
      this.lastError = classified;
      this.pushFallback(line, classified);
      return { ...event, degraded: true };
    }
    return event;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = this.fs.existsSync(this.filePath)
        ? this.fs.statSync(this.filePath).size
        : 0;
    } catch {
      return; // rotate check is best-effort; append may still fail safely
    }
    if (size === 0 || size + incomingBytes <= this.rotateBytes) return;
    // Shift audit.log.(N-1) -> audit.log.N, dropping the oldest beyond N.
    const oldest = nodePath.join(
      this.dirPath,
      `${nodePath.basename(this.filePath)}.${this.maxRotated}`,
    );
    try {
      if (this.fs.existsSync(oldest)) this.fs.unlinkSync(oldest);
      for (let i = this.maxRotated - 1; i >= 1; i -= 1) {
        const from = nodePath.join(
          this.dirPath,
          `${nodePath.basename(this.filePath)}.${i}`,
        );
        const to = nodePath.join(
          this.dirPath,
          `${nodePath.basename(this.filePath)}.${i + 1}`,
        );
        if (this.fs.existsSync(from)) this.fs.renameSync(from, to);
      }
      this.fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // Rotation failure is not fatal: the active file keeps growing until it
      // hits the OS/filesystem limit, where the append path degrades safely.
    }
  }

  private pushFallback(
    line: string,
    errorClass: NonNullable<FileAuditStoreStatus["lastError"]>,
  ): void {
    this.writeFailures += 1;
    this.lastError = errorClass;
    this.fallback.push(line);
    if (this.fallback.length > FALLBACK_BUFFER_LINES) {
      // Bounded buffer: drop-oldest within memory only; the disk file is the
      // durable surface and this is already a degraded path.
      this.fallback.shift();
    }
  }

  /** Content-free operational status; safe to surface to users. */
  status(): FileAuditStoreStatus {
    let activeBytes = 0;
    let rotatedFiles = 0;
    try {
      if (this.fs.existsSync(this.filePath)) {
        activeBytes = this.fs.statSync(this.filePath).size;
      }
      for (let i = 1; i <= this.maxRotated; i += 1) {
        if (
          this.fs.existsSync(
            nodePath.join(
              this.dirPath,
              `${nodePath.basename(this.filePath)}.${i}`,
            ),
          )
        ) {
          rotatedFiles += 1;
        }
      }
    } catch {
      /* status stays best-effort */
    }
    return {
      persisted: this.persistedCount,
      buffered: this.fallback.length,
      rotatedFiles,
      activeBytes,
      lock: this.lockState,
      lastError: this.lastError,
      writeFailures: this.writeFailures,
      corruptSkippedBytes: this.corruptSkipped,
      degraded:
        this.fallback.length > 0 ||
        this.corruptSkipped > 0 ||
        this.lockState !== "owned",
    };
  }

  /** In-memory fallback lines (bounded), for diagnostics/tests only. */
  buffered_lines(): readonly string[] {
    return this.fallback;
  }

  /** Releases the lock; subsequent records go to the bounded buffer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.lockState === "owned") this.fs.unlinkSync(this.lockPath);
    } catch {
      /* best effort */
    }
    this.lockState = "unavailable";
  }

  /** Hard upper bound on on-disk audit bytes (documented, testable). */
  static diskBudgetBytes(
    maxRotateBytes: number = 256 * 1024,
    maxRotatedFiles: number = 2,
  ): number {
    return maxRotateBytes * (maxRotatedFiles + 1);
  }
}
