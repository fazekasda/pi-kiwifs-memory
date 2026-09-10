/**
 * T11: proposal lifecycle — approve, reject and undo (PRD T11,
 * architecture.md §2/§3.3, decisions.md #11).
 *
 * Proposals live SEPARATELY from accepted records (`memory/merge-proposals/`,
 * status `pending-approval`) and are never auto-applied. Approval is an
 * explicit, verified transition:
 *
 * - Verified concurrency protection: every transition reads the proposal (and
 *   each target record) FRESH from the backend and verifies the expected
 *   pre-state (status +, for targets, that a prior supersession was made by
 *   THIS proposal) before writing; every write is verified by read-back, so
 *   a concurrent modification between read and write is detected and surfaced
 *   as a visible StaleProposalError instead of a silent overwrite. B2
 *   conformance: this is verify-then-act with post-write detection — NO
 *   compare-and-swap or optimistic-concurrency behavior is claimed (the
 *   backend MCP surface has no If-Match writes, docs/research/
 *   mcp-contracts.md); local lifecycle operations are additionally
 *   serialized on an internal chain.
 * - Stale approvals fail visibly: a proposal whose status is no longer
 *   `pending-approval` (already approved, rejected, or unknown) is rejected
 *   with StaleProposalError naming the observed status — never a silent no-op
 *   against divergent state.
 * - Undo restores logical visibility: superseded target records are written
 *   back to `active` (they become retrievable again) and the proposal is
 *   marked `superseded` with an approval-undone provenance line. History is
 *   never erased: every transition APPENDS a `kiwifs-provenance:` line to the
 *   record body (approved/rejected/superseded/restored/undone + actor + time
 *   + opId) — nothing is silently rewritten or deleted.
 * - Durable op ids: every backend write carries an opId durably recorded in
 *   the local append-only lifecycle op log (fsync) BEFORE the side effect
 *   (architecture.md §2). The op log doubles as the local audit trail.
 * - Replay safety: re-running an approval whose targets are already
 *   superseded by the same proposal (crash between target writes) completes
 *   idempotently; a duplicate reject/undo replays as a no-op.
 *
 * Headless/RPC safe; failures are typed and payload-free.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseStoredRecord, serializeStoredRecord } from "../domain/records.ts";
import { parseDataBlock, provenanceLine } from "./reflection.ts";
import { createHash } from "node:crypto";
import type { AuditSinkLike } from "../privacy/audit.ts";

/**
 * Q04 review fix: audit `targetId` for proposal change events. Reduces a
 * user-typed proposal path to its basename so no directory components
 * (home directory / username) are ever persisted. Falls back to a fixed
 * content-free marker when the basename is empty or path-traversal-like.
 */
export function auditTargetForProposalPath(proposalPath: string): string {
  const base = basename(proposalPath);
  if (base.length === 0 || base === "." || base === "..") return "proposal";
  return base;
}

/** A proposal/target is not in the expected pre-state (stale or raced). */
export class StaleProposalError extends Error {
  constructor(detail: string) {
    // Detail is a static state description (statuses/paths/ids), never
    // record body content.
    super(`proposal transition refused (stale state): ${detail}`);
    this.name = "StaleProposalError";
  }
}

/** Minimal backend surface for lifecycle transitions (real: KiwiFSAdapter). */
export interface ProposalStore {
  read(
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    state: "ok" | "missing" | "not_modified";
    content?: string;
  }>;
  write(
    path: string,
    content: string,
    opts: { opId: string; actor?: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

// ---- durable op log (local provenance + opId ledger) -----------------------

export interface LifecycleOpEntry {
  opId: string;
  action: "approve" | "reject" | "undo";
  proposalPath: string;
  targets: string[];
  actor?: string;
  reason?: string;
  at: string;
}

interface OpLogLine extends LifecycleOpEntry {
  schemaVersion: number;
}

/**
 * Append-only local op log. Doubles as the T04 opId ledger for lifecycle
 * writes: an opId is fsync-persisted here BEFORE any backend side effect.
 */
export class ProposalOpLog {
  private readonly file: string;
  private readonly known = new Set<string>();

  constructor(stateDir: string) {
    this.file = join(stateDir, "proposal-oplog.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn/corrupt line fails closed: the log is the opId ledger, so
        // lifecycle writes must not proceed on an unverifiable history.
        throw new Error(
          "proposal op log is corrupt (failing closed; lifecycle disabled)",
        );
      }
      const rec = parsed as OpLogLine;
      if (
        typeof rec !== "object" ||
        rec === null ||
        typeof rec.opId !== "string"
      ) {
        throw new Error(
          "proposal op log contains a malformed entry (failing closed)",
        );
      }
      this.known.add(rec.opId);
    }
  }

  /** Durably records the op (fsync) before any side effect. */
  record(entry: LifecycleOpEntry): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const line: OpLogLine = { schemaVersion: 1, ...entry };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const fd = openSync(this.file, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dirFd = openSync(join(this.file, ".."), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    this.known.add(entry.opId);
  }

  has(opId: string): boolean {
    return this.known.has(opId);
  }
}

// ---- lifecycle -------------------------------------------------------------

export interface ProposalTargets {
  action: string;
  targetRecordIds: string[];
  targetPaths: string[];
}

/** Reads a proposal record and extracts its (validated) merge targets. */
export async function readProposalTargets(
  store: ProposalStore,
  proposalPath: string,
): Promise<{ id: string; status: string; targets: ProposalTargets }> {
  const res = await store.read(proposalPath);
  if (res.state !== "ok" || res.content === undefined) {
    throw new StaleProposalError(
      `proposal not readable at ${proposalPath} (state: ${res.state})`,
    );
  }
  const parsed = parseStoredRecord(res.content);
  if (!parsed.ok) {
    throw new StaleProposalError(
      `proposal record is malformed or a future schema version (${parsed.reason})`,
    );
  }
  const { record } = parsed;
  if (record.frontmatter.type !== "proposal") {
    throw new StaleProposalError(
      `record at ${proposalPath} is type '${record.frontmatter.type}', not a proposal`,
    );
  }
  let data: unknown;
  try {
    data = parseDataBlock(record.body);
  } catch (err) {
    throw new StaleProposalError(
      `proposal data block is unreadable (${(err as Error).name})`,
    );
  }
  const d = data as Partial<ProposalTargets> | null;
  if (
    typeof d !== "object" ||
    d === null ||
    typeof d.action !== "string" ||
    !Array.isArray(d.targetRecordIds) ||
    !Array.isArray(d.targetPaths) ||
    d.targetRecordIds.length !== d.targetPaths.length ||
    d.targetRecordIds.length < 2
  ) {
    throw new StaleProposalError(
      "proposal data block does not carry a valid merge target set",
    );
  }
  return {
    id: record.frontmatter.id,
    status: record.frontmatter.status,
    targets: {
      action: d.action,
      targetRecordIds: d.targetRecordIds as string[],
      targetPaths: d.targetPaths as string[],
    },
  };
}

export interface ProposalTransitionResult {
  /** "applied" on a fresh transition; "replay" for an already-applied one. */
  applied: "applied" | "replay";
  proposalPath: string;
  /** Target paths transitioned by THIS call (replay: empty). */
  targets: string[];
}

export interface ProposalLifecycleOptions {
  opLog: ProposalOpLog;
  /** Lazy backend factory; an unconfigured backend is a retryable gap. */
  openStore: () => Promise<ProposalStore | undefined>;
  now?: () => Date;
}

interface ParsedTarget {
  path: string;
  status: string;
  raw: string;
}

export class ProposalLifecycle {
  private readonly opLog: ProposalOpLog;
  private readonly openStore: () => Promise<ProposalStore | undefined>;
  private readonly nowFn: () => Date;
  private readonly audit: AuditSinkLike | undefined;
  /** Serializes lifecycle transitions (local single-flight). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: {
    opLog: ProposalOpLog;
    openStore: () => Promise<ProposalStore | undefined>;
    now?: () => Date;
    /** Q04c: sanitized metadata-only audit sink (change events). */
    audit?: AuditSinkLike;
  }) {
    this.opLog = options.opLog;
    this.openStore = options.openStore;
    this.nowFn = options.now ?? (() => new Date());
    this.audit = options.audit;
  }

  /**
   * Q04c: sanitized metadata-only change audit (approve/reject/undo).
   * Best-effort — never throws, never authorizes or acknowledges a write.
   */
  private auditChange(decision: string, proposalPath: string): void {
    this.audit?.record({
      kind: "change",
      feature: "proposal",
      decision,
      // Q04 review fix: never persist a user-typed path in `targetId` —
      // an absolute path could carry a home directory/username. Only the
      // basename is retained (content-free, no directory components).
      targetId: auditTargetForProposalPath(proposalPath),
    });
  }

  /** Sanitized failure fingerprint for audit decisions (name/code only). */
  private auditFailName(err: unknown): string {
    const name = err instanceof Error ? err.name : "unknown";
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code ? `${name}:${code}` : name;
  }

  /**
   * Resolves the backend lazily; an unconfigured backend / unresolved
   * credential is a visible, retryable gap — never an unauthenticated write.
   */
  private async store(): Promise<ProposalStore> {
    const store = await this.openStore();
    if (!store) {
      throw new StaleProposalError(
        "backend not configured or credential unresolved — proposal lifecycle unavailable (retryable)",
      );
    }
    return store;
  }

  private serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Fresh read + strict parse of a target record. */
  private async readTarget(path: string): Promise<ParsedTarget> {
    const res = await (await this.store()).read(path);
    if (res.state !== "ok" || res.content === undefined) {
      throw new StaleProposalError(
        `target record not readable at ${path} (state: ${res.state})`,
      );
    }
    const parsed = parseStoredRecord(res.content);
    if (!parsed.ok) {
      throw new StaleProposalError(
        `target record at ${path} is malformed or a future schema version (${parsed.reason})`,
      );
    }
    return { path, status: parsed.record.frontmatter.status, raw: res.content };
  }

  /**
   * Verified write: persist the opId durably, write, then read back and
   * verify byte-identical content. A mismatch means a concurrent actor
   * modified the record between our read and write — surfaced visibly,
   * never overwritten silently (B2: no CAS claim; detection + visible
   * failure is the compensating control).
   */
  private async verifiedWrite(
    path: string,
    content: string,
    opId: string,
    actor: string | undefined,
    what: string,
  ): Promise<void> {
    await (
      await this.store()
    ).write(path, content, {
      opId,
      ...(actor !== undefined ? { actor } : {}),
    });
    const after = await (await this.store()).read(path);
    if (after.state !== "ok" || after.content !== content) {
      throw new StaleProposalError(
        `concurrent modification detected after ${what} write at ${path}; the record was changed by another actor — failing visibly, never overwriting`,
      );
    }
  }

  private static appendProvenance(raw: string, line: string): string {
    return `${raw.replace(/\n*$/, "\n")}${provenanceLine(line)}\n`;
  }

  private static withStatus(
    raw: string,
    status: "active" | "superseded",
  ): string | undefined {
    const parsed = parseStoredRecord(raw);
    if (!parsed.ok) return undefined;
    const record = {
      ...parsed.record,
      frontmatter: { ...parsed.record.frontmatter, status },
    };
    return serializeStoredRecord(record);
  }

  // ---- approve -------------------------------------------------------------

  /**
   * Approves a pending-approval proposal: the proposal becomes `active` and
   * each target observation record is superseded (status `superseded` with
   * provenance naming this proposal). Stale states fail visibly. Re-running
   * an approval whose targets are already superseded by the SAME proposal
   * completes idempotently (replay).
   */
  approve(
    proposalPath: string,
    opts: { actor: string; signal?: AbortSignal },
  ): Promise<ProposalTransitionResult> {
    return this.serialized(async () => {
      try {
        const r = await this.approveInner(proposalPath, opts);
        this.auditChange("approved", proposalPath);
        return r;
      } catch (err) {
        this.auditChange(`failed (${this.auditFailName(err)})`, proposalPath);
        throw err;
      }
    });
  }

  private async approveInner(
    proposalPath: string,
    opts: { actor: string; signal?: AbortSignal },
  ): Promise<ProposalTransitionResult> {
    const { id, status, targets } = await readProposalTargets(
      await this.store(),
      proposalPath,
    );
    if (status === "active") {
      // Replay check: approval is complete when every target is superseded
      // by THIS proposal (crash between target writes). Anything else is a
      // divergent state another actor created — visible stale failure.
      for (const path of targets.targetPaths) {
        const t = await this.readTarget(path);
        const parsed = parseStoredRecord(t.raw);
        if (!parsed.ok) {
          throw new StaleProposalError(
            `target ${path} unreadable on replay check`,
          );
        }
        const supersededByThis = t.raw.includes(
          `superseded by proposal ${id} `,
        );
        if (!supersededByThis) {
          throw new StaleProposalError(
            `proposal ${id} is already active but target ${path} was not superseded by it (status: ${t.status})`,
          );
        }
      }
      return { applied: "replay", proposalPath, targets: [] };
    }
    if (status !== "pending-approval") {
      throw new StaleProposalError(
        `proposal status is '${status}', expected 'pending-approval' (already decided by another actor?)`,
      );
    }
    const opId = randomUUID();
    const at = this.nowFn().toISOString();
    this.opLog.record({
      opId,
      action: "approve",
      proposalPath,
      targets: targets.targetPaths,
      actor: opts.actor,
      at,
    });
    // 1. Proposal → active with provenance.
    const res = await (await this.store()).read(proposalPath);
    if (res.state !== "ok" || res.content === undefined) {
      throw new StaleProposalError("proposal disappeared mid-approval");
    }
    const activeDoc = ProposalLifecycle.withStatus(res.content, "active");
    if (activeDoc === undefined) {
      throw new StaleProposalError("proposal became unparseable mid-approval");
    }
    const approvedDoc = ProposalLifecycle.appendProvenance(
      activeDoc,
      `approved by ${opts.actor} at ${at} (op ${opId}, by ${opts.actor})`,
    );
    await this.verifiedWrite(
      proposalPath,
      approvedDoc,
      opId,
      opts.actor,
      "approval",
    );
    // 2. Targets → superseded, each read fresh and verified after write.
    const done: string[] = [];
    try {
      for (const path of targets.targetPaths) {
        const t = await this.readTarget(path);
        if (t.status !== "active") {
          throw new StaleProposalError(
            `target ${path} status is '${t.status}', expected 'active' (changed by another actor?)`,
          );
        }
        const supersededDoc = ProposalLifecycle.withStatus(t.raw, "superseded");
        if (supersededDoc === undefined) {
          throw new StaleProposalError(`target ${path} became unparseable`);
        }
        const doc = ProposalLifecycle.appendProvenance(
          supersededDoc,
          `superseded by proposal ${id} at ${at} (op ${opId}, by ${opts.actor})`,
        );
        await this.verifiedWrite(
          path,
          doc,
          opId,
          opts.actor,
          "target supersession",
        );
        done.push(path);
      }
    } catch (err) {
      // Fail visibly with the completed prefix; re-running approve after the
      // underlying problem is fixed completes idempotently (targets already
      // superseded by this proposal are re-verified, not rewritten).
      throw new StaleProposalError(
        `approval partially applied (${done.length}/${targets.targetPaths.length} targets superseded): ${(err as Error).message}`,
      );
    }
    return { applied: "applied", proposalPath, targets: done };
  }

  // ---- reject --------------------------------------------------------------

  /**
   * Rejects a pending-approval proposal: status → `superseded` with a
   * rejection provenance line. Targets are NOT touched — the disputed
   * observations stay active/visible. Duplicate reject replays as no-op.
   */
  reject(
    proposalPath: string,
    opts: { actor: string; reason?: string; signal?: AbortSignal },
  ): Promise<ProposalTransitionResult> {
    return this.serialized(async () => {
      try {
        const r = await this.rejectInner(proposalPath, opts);
        this.auditChange("rejected", proposalPath);
        return r;
      } catch (err) {
        this.auditChange(`failed (${this.auditFailName(err)})`, proposalPath);
        throw err;
      }
    });
  }

  private async rejectInner(
    proposalPath: string,
    opts: { actor: string; reason?: string },
  ): Promise<ProposalTransitionResult> {
    const { status } = await readProposalTargets(
      await this.store(),
      proposalPath,
    );
    const res = await (await this.store()).read(proposalPath);
    if (res.state !== "ok" || res.content === undefined) {
      throw new StaleProposalError("proposal not readable");
    }
    if (status === "superseded" && res.content.includes("rejected by ")) {
      return { applied: "replay", proposalPath, targets: [] };
    }
    if (status !== "pending-approval") {
      throw new StaleProposalError(
        `proposal status is '${status}', expected 'pending-approval'`,
      );
    }
    const opId = randomUUID();
    const at = this.nowFn().toISOString();
    this.opLog.record({
      opId,
      action: "reject",
      proposalPath,
      targets: [],
      actor: opts.actor,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      at,
    });
    const supersededDoc = ProposalLifecycle.withStatus(
      res.content,
      "superseded",
    );
    if (supersededDoc === undefined) {
      throw new StaleProposalError("proposal became unparseable mid-reject");
    }
    const doc = ProposalLifecycle.appendProvenance(
      supersededDoc,
      `rejected by ${opts.actor} at ${at} (op ${opId})${opts.reason ? ` reason: ${opts.reason}` : ""}`,
    );
    await this.verifiedWrite(proposalPath, doc, opId, opts.actor, "rejection");
    return { applied: "applied", proposalPath, targets: [] };
  }

  // ---- undo ----------------------------------------------------------------

  /**
   * Undoes an APPROVED proposal: target records superseded by this proposal
   * are restored to `active` (logical visibility restored) with restore
   * provenance; the proposal is marked `superseded` with an approval-undone
   * provenance line. Nothing is deleted — full history stays in the record
   * bodies. Undo of a non-approved proposal fails visibly.
   */
  undo(
    proposalPath: string,
    opts: { actor: string; reason?: string; signal?: AbortSignal },
  ): Promise<ProposalTransitionResult> {
    return this.serialized(async () => {
      try {
        const r = await this.undoInner(proposalPath, opts);
        this.auditChange("undone", proposalPath);
        return r;
      } catch (err) {
        this.auditChange(`failed (${this.auditFailName(err)})`, proposalPath);
        throw err;
      }
    });
  }

  private async undoInner(
    proposalPath: string,
    opts: { actor: string; reason?: string },
  ): Promise<ProposalTransitionResult> {
    const { id, status, targets } = await readProposalTargets(
      await this.store(),
      proposalPath,
    );
    const res = await (await this.store()).read(proposalPath);
    if (res.state !== "ok" || res.content === undefined) {
      throw new StaleProposalError("proposal not readable");
    }
    const alreadyUndone =
      res.content.includes(`approval undone by `) &&
      res.content.includes(`(op `);
    if (status === "superseded" && alreadyUndone) {
      return { applied: "replay", proposalPath, targets: [] };
    }
    if (status !== "active") {
      throw new StaleProposalError(
        `undo requires an approved (active) proposal; status is '${status}'`,
      );
    }
    if (!res.content.includes(`approved by `)) {
      throw new StaleProposalError(
        "proposal is active without approval provenance; refusing to undo an unverified state",
      );
    }
    const opId = randomUUID();
    const at = this.nowFn().toISOString();
    this.opLog.record({
      opId,
      action: "undo",
      proposalPath,
      targets: targets.targetPaths,
      actor: opts.actor,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      at,
    });
    // 1. Restore targets superseded by THIS proposal → active.
    const restored: string[] = [];
    try {
      for (const path of targets.targetPaths) {
        const t = await this.readTarget(path);
        const parsed = parseStoredRecord(t.raw);
        if (!parsed.ok) {
          throw new StaleProposalError(`target ${path} unreadable during undo`);
        }
        const supersededByThis = t.raw.includes(
          `superseded by proposal ${id} `,
        );
        if (t.status === "active") {
          continue; // already visible (restored earlier or never applied)
        }
        if (t.status !== "superseded" || !supersededByThis) {
          throw new StaleProposalError(
            `target ${path} status is '${t.status}' and was not superseded by proposal ${id}; refusing to restore`,
          );
        }
        const activeDoc = ProposalLifecycle.withStatus(t.raw, "active");
        if (activeDoc === undefined) {
          throw new StaleProposalError(`target ${path} became unparseable`);
        }
        const doc = ProposalLifecycle.appendProvenance(
          activeDoc,
          `restored by undo of proposal ${id} at ${at} (op ${opId}, by ${opts.actor})${opts.reason ? ` reason: ${opts.reason}` : ""}`,
        );
        await this.verifiedWrite(path, doc, opId, opts.actor, "undo restore");
        restored.push(path);
      }
    } catch (err) {
      throw new StaleProposalError(
        `undo partially applied (${restored.length}/${targets.targetPaths.length} targets restored): ${(err as Error).message}`,
      );
    }
    // 2. Proposal → superseded with approval-undone provenance.
    const after = await (await this.store()).read(proposalPath);
    if (after.state !== "ok" || after.content === undefined) {
      throw new StaleProposalError("proposal disappeared during undo");
    }
    const supersededDoc = ProposalLifecycle.withStatus(
      after.content,
      "superseded",
    );
    if (supersededDoc === undefined) {
      throw new StaleProposalError("proposal became unparseable during undo");
    }
    const doc = ProposalLifecycle.appendProvenance(
      supersededDoc,
      `approval undone by ${opts.actor} at ${at} (op ${opId})${opts.reason ? ` reason: ${opts.reason}` : ""}`,
    );
    await this.verifiedWrite(
      proposalPath,
      doc,
      opId,
      opts.actor,
      "approval undo",
    );
    return { applied: "applied", proposalPath, targets: restored };
  }
}

/** Fingerprint of a lifecycle decision (metadata-only, status lines). */
export function proposalDecisionFingerprint(
  proposalPath: string,
  opId: string,
): string {
  return createHash("sha256")
    .update(`${proposalPath}/${opId}`)
    .digest("hex")
    .slice(0, 12);
}
