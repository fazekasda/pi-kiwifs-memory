/**
 * T14: incremental transcript backup capture (architecture.md §6/§7,
 * decisions.md #2, PRD T14).
 *
 * Responsibilities:
 * - Incremental capture of completed session entries against a DURABLE
 *   coverage cursor: an entry is captured exactly once per session
 *   (interrupted capture resumes without missing or duplicating accepted
 *   entries — re-derivation from uncovered entries reproduces identical
 *   chunk seq/content, so backend replays are no-ops).
 * - Redaction at the chunk edge (privacy gate on every outbound edge, §5):
 *   text is redacted BEFORE serialization; a redaction failure holds the
 *   affected entries (fail closed) — they stay uncovered and visibly pending,
 *   never sent raw.
 * - Binary content, user-excluded content and extension-internal entries are
 *   omitted and recorded in the manifest (never silently dropped).
 * - Every chunk is persisted to the outbox (kind "backup-chunk") BEFORE the
 *   coverage cursor advances (decisions.md #8); a crash between the two
 *   re-derives the same chunk under a fresh opId — identical content, so the
 *   backend replay is a no-op and no duplicate job effect exists.
 * - The manifest is derived from durable state and enqueued after any chunk
 *   flush; the manifest path is the single mutable backup path (§7 — it
 *   carries only checksums/counts/IDs, never content).
 *
 * Raw transcript records live under `backup/…`, outside every scope's
 * `memory/` namespace: ordinary RAG retrieval filters to `{scope}/memory/`,
 * so backup chunks are not automatically eligible for memory retrieval.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openSync, closeSync, fsyncSync, writeSync } from "node:fs";
import type { DurableOutbox } from "../outbox/store.ts";
import type { OutboxJob } from "../outbox/store.ts";
import { idempotencyKey } from "../domain/idempotency.ts";
import { backupChunkPath, backupManifestPath } from "../domain/paths.ts";
import { ValidationError } from "../backend/errors.ts";
import { createRedactor } from "../privacy/redaction.ts";
import type { AuditSinkLike } from "../privacy/audit.ts";
import type { ExclusionRule } from "../privacy/exclusions.ts";
import { compileExclusions } from "../privacy/exclusions.ts";
import {
  BACKUP_SCHEMA_VERSION,
  toBackupViews,
  type BackupView,
} from "./exporter.ts";
import {
  chunkChecksum,
  chunkEntries,
  serializeChunk,
  type BackupEntry,
} from "./chunker.ts";
import {
  buildBackupManifest,
  serializeBackupManifest,
  type ManifestChunk,
  type ManifestOmission,
} from "./manifest.ts";

export const BACKUP_STATE_SCHEMA_VERSION = 1;
const STATE_FILE = "backup-state.json";

interface SessionBackupState {
  /** Coverage cursor: entry ids already represented in the backup. */
  coveredEntryIds: string[];
  nextSeq: number;
  chunks: ManifestChunk[];
  redactionSummary: Record<string, number>;
  omissions: ManifestOmission[];
  /** Raw redaction finding counts accumulated across chunks. */
  redactionCounts: Record<string, number>;
}

interface BackupState {
  schemaVersion: number;
  sessions: Record<string, SessionBackupState>;
}

export interface BackupCaptureOptions {
  stateDir: string;
  outbox: DurableOutbox;
  /** Owner scope (`project/{id}`); backup requires a resolved project scope. */
  scope: string;
  /** Project id for the `backup/{project-id}/` namespace (validated there). */
  projectId: string;
  sessionId: string;
  branchId?: string;
  /** Private mode: no new backup jobs (checked on every capture). */
  privateMode?: () => boolean;
  /** Raw user exclusion rules; invalid patterns fail closed (config error). */
  exclusions?: ExclusionRule[];
  redact?: (
    content: string,
  ) => { ok: true; content: string } | { ok: false; reason: string };
  /** Q04c: sanitized metadata-only audit sink (capture/hold events). */
  audit?: AuditSinkLike;
  maxChunkBytes?: number;
  now?: () => number;
}

export interface BackupCaptureResult {
  /** Chunk jobs durably enqueued this flush. */
  enqueuedChunks: number;
  /** Manifest job enqueued this flush (only when chunks were enqueued). */
  enqueuedManifest: boolean;
  /** Entries held back (redaction failure) — durably uncovered, visible. */
  heldEntries: number;
  skippedReason?: "private-mode" | "no-candidates";
  lastError?: string;
}

function emptySessionState(): SessionBackupState {
  return {
    coveredEntryIds: [],
    nextSeq: 0,
    chunks: [],
    redactionSummary: {},
    omissions: [],
    redactionCounts: {},
  };
}

/** Payload for a chunk delivery job (kind "backup-chunk", type "chunk"). */
export interface BackupChunkPayload {
  type: "chunk";
  sessionId: string;
  branchId?: string;
  seq: number;
  /** Entry ids covered by this chunk (provenance; also the job sources). */
  entryIds: string[];
  /** Exact serialized chunk content (deterministic; redacted). */
  content: string;
  checksum: string;
}

/** Payload for the manifest delivery job (kind "backup-chunk", type "manifest"). */
export interface BackupManifestPayload {
  type: "manifest";
  sessionId: string;
  manifest: string;
}

export type BackupPayload = BackupChunkPayload | BackupManifestPayload;

/**
 * Validates the job payload AGAIN at delivery (defense in depth, mirroring
 * the observation sender): shape, session/seq integrity and — critically —
 * that the chunk content is the serialization its own header claims (the
 * checksum must match, and the chunk's entry ids must equal the job's
 * declared sources).
 */
export function parseBackupPayload(job: OutboxJob): BackupPayload {
  const p = job.payload as Partial<BackupPayload> | null;
  if (typeof p !== "object" || p === null || typeof p.type !== "string") {
    throw new ValidationError(
      "backup job payload is missing its type discriminator",
      "kiwi_write",
    );
  }
  if (p.type === "manifest") {
    const m = p as Partial<BackupManifestPayload>;
    if (
      typeof m.sessionId !== "string" ||
      m.sessionId === "" ||
      typeof m.manifest !== "string" ||
      m.manifest === ""
    ) {
      throw new ValidationError(
        "backup manifest payload is missing required fields",
        "kiwi_write",
      );
    }
    return p as BackupManifestPayload;
  }
  if (p.type !== "chunk") {
    throw new ValidationError(
      `backup job payload has unknown type: ${p.type}`,
      "kiwi_write",
    );
  }
  const c = p as Partial<BackupChunkPayload>;
  if (
    typeof c.sessionId !== "string" ||
    c.sessionId === "" ||
    !Array.isArray(c.entryIds) ||
    c.entryIds.some((id) => typeof id !== "string" || id === "") ||
    !Number.isInteger(c.seq) ||
    (c.seq as number) < 0 ||
    typeof c.content !== "string" ||
    c.content === "" ||
    typeof c.checksum !== "string"
  ) {
    throw new ValidationError(
      "backup chunk payload is missing required fields",
      "kiwi_write",
    );
  }
  // Chunk header integrity: the serialized content must self-describe the
  // same session/seq and carry exactly the declared entry set, and the
  // payload checksum must match the exact bytes (delivery-side re-check).
  let parsed: unknown;
  try {
    parsed = JSON.parse(c.content);
  } catch {
    throw new ValidationError(
      "backup chunk content is not valid JSON",
      "kiwi_write",
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj === null ||
    obj["kind"] !== "kiwifs-backup-chunk" ||
    obj["sessionId"] !== c.sessionId ||
    obj["seq"] !== c.seq ||
    !Array.isArray(obj["entries"])
  ) {
    throw new ValidationError(
      "backup chunk content does not match its payload header",
      "kiwi_write",
    );
  }
  const contentIds = (obj["entries"] as { id?: unknown }[]).map((e) =>
    String(e?.id ?? ""),
  );
  if (
    contentIds.length !== c.entryIds?.length ||
    contentIds.some((id, i) => id !== c.entryIds?.[i])
  ) {
    throw new ValidationError(
      "backup chunk entry ids diverge from the job's declared sources",
      "kiwi_write",
    );
  }
  if (chunkChecksum(c.content) !== c.checksum) {
    throw new ValidationError(
      "backup chunk checksum does not match its content (tampered payload)",
      "kiwi_write",
    );
  }
  return c as BackupChunkPayload;
}

/** Minimal backend surface the backup sender needs (real: KiwiFSAdapter). */
export interface BackupBackend {
  writeImmutable(
    path: string,
    content: string,
    opts: { opId: string; signal?: AbortSignal },
  ): Promise<{ replayed: boolean }>;
  /** Mutable write — used ONLY for the manifest path (see manifest.ts). */
  write(
    path: string,
    content: string,
    opts: { opId: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

/**
 * Delivers one backup job. Chunk paths are immutable (read-before-write
 * replay no-op, B2). The manifest path is the single mutable backup path:
 * it is rewritten (never merged) with the full derived manifest; a replay
 * of the same job rewrites identical content — idempotent in effect.
 */
export async function sendBackupJob(
  job: OutboxJob,
  scope: string,
  projectId: string,
  backend: BackupBackend,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const payload = parseBackupPayload(job);
  if (payload.type === "manifest") {
    await backend.write(
      backupManifestPath(projectId, payload.sessionId),
      payload.manifest,
      {
        opId: job.opId,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    return;
  }
  const content = serializeChunk({
    sessionId: payload.sessionId,
    seq: payload.seq,
    entries: (JSON.parse(payload.content) as { entries: BackupEntry[] })
      .entries,
  });
  if (content !== payload.content) {
    throw new ValidationError(
      "backup chunk content is not byte-stable (re-serialization diverged)",
      "kiwi_write",
    );
  }
  await backend.writeImmutable(
    backupChunkPath(projectId, payload.sessionId, payload.seq),
    payload.content,
    {
      opId: job.opId,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
  );
}

/**
 * Incremental backup capture engine. One instance per session runtime;
 * durable state survives crashes and resumes from the coverage cursor.
 */
export class BackupCapture {
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly outbox: DurableOutbox;
  readonly scope: string;
  readonly projectId: string;
  sessionId: string;
  private branchId: string | undefined;
  private readonly privateMode: () => boolean;
  private readonly exclusions: {
    rule: ExclusionRule;
    regex?: RegExp;
  }[];
  private readonly exclusionsValid: boolean;
  private readonly redact: (
    content: string,
  ) => { ok: true; content: string } | { ok: false; reason: string };
  private readonly maxChunkBytes: number | undefined;
  private readonly nowFn: () => number;
  private readonly audit: AuditSinkLike | undefined;
  private state: BackupState;
  /** Last error (sanitized) for visible status. */
  lastError: string | undefined;

  constructor(options: BackupCaptureOptions) {
    if (!options.scope.startsWith("project/")) {
      throw new Error(
        "backup capture requires a resolved project scope (project/{id})",
      );
    }
    this.stateDir = options.stateDir;
    this.stateFile = join(this.stateDir, STATE_FILE);
    this.outbox = options.outbox;
    this.scope = options.scope;
    this.projectId = options.projectId;
    this.sessionId = options.sessionId;
    this.branchId = options.branchId;
    this.privateMode = options.privateMode ?? (() => false);
    const compiled = compileExclusions(options.exclusions ?? []);
    this.exclusionsValid = compiled.ok;
    this.exclusions = compiled.ok ? compiled.compiled : [];
    if (!compiled.ok) {
      this.lastError = `exclusions invalid — backup capture held (${compiled.reason})`;
    }
    this.redact = options.redact ?? createRedactor();
    this.maxChunkBytes = options.maxChunkBytes;
    this.nowFn = options.now ?? (() => Date.now());
    this.audit = options.audit;
    this.state = this.loadState();
  }

  /**
   * Q04c: sanitized metadata-only backup audit event. Best-effort — never
   * throws, never authorizes or acknowledges work.
   */
  private auditEvent(
    decision: string,
    extra?: { byteCounts?: Record<string, number> },
  ): void {
    this.audit?.record({
      kind: "backup",
      feature: "backup",
      scope: this.scope,
      decision,
      ...(extra?.byteCounts !== undefined
        ? { byteCounts: extra.byteCounts }
        : {}),
    });
  }

  // ---- durable state ------------------------------------------------------

  private sessionState(sessionId: string): SessionBackupState {
    let s = this.state.sessions[sessionId];
    if (!s) {
      s = emptySessionState();
      this.state.sessions[sessionId] = s;
    }
    return s;
  }

  private loadState(): BackupState {
    if (!existsSync(this.stateFile)) {
      return { schemaVersion: BACKUP_STATE_SCHEMA_VERSION, sessions: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      // Corrupt state fails safe to empty: chunks already delivered remain
      // intact remotely; local re-derivation re-enqueues no-op replays.
      return { schemaVersion: BACKUP_STATE_SCHEMA_VERSION, sessions: {} };
    }
    const s = parsed as Partial<BackupState>;
    if (
      typeof s !== "object" ||
      s === null ||
      (s.schemaVersion ?? 0) > BACKUP_STATE_SCHEMA_VERSION
    ) {
      // Unknown newer schema: fail safe, never destructively rewrite (§9).
      throw new Error(
        `backup-state.json schemaVersion ${String(s.schemaVersion)} is newer than supported — backup capture disabled (read-only fail-safe)`,
      );
    }
    const sessions: Record<string, SessionBackupState> = {};
    if (typeof s.sessions === "object" && s.sessions !== null) {
      for (const [key, value] of Object.entries(
        s.sessions as Record<string, unknown>,
      )) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Partial<SessionBackupState>;
        sessions[key] = {
          coveredEntryIds: Array.isArray(v.coveredEntryIds)
            ? v.coveredEntryIds.filter(
                (x): x is string => typeof x === "string",
              )
            : [],
          nextSeq:
            typeof v.nextSeq === "number" && Number.isSafeInteger(v.nextSeq)
              ? v.nextSeq
              : 0,
          chunks: Array.isArray(v.chunks)
            ? (v.chunks as ManifestChunk[]).filter(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  typeof c.checksum === "string" &&
                  Number.isInteger(c.seq),
              )
            : [],
          redactionSummary:
            typeof v.redactionSummary === "object" &&
            v.redactionSummary !== null
              ? (v.redactionSummary as Record<string, number>)
              : {},
          omissions: Array.isArray(v.omissions)
            ? (v.omissions as ManifestOmission[]).filter(
                (o) =>
                  typeof o === "object" &&
                  o !== null &&
                  typeof o.entryId === "string" &&
                  typeof o.reason === "string",
              )
            : [],
          redactionCounts:
            typeof v.redactionCounts === "object" && v.redactionCounts !== null
              ? (v.redactionCounts as Record<string, number>)
              : {},
        };
      }
    }
    return { schemaVersion: BACKUP_STATE_SCHEMA_VERSION, sessions };
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

  // ---- capture ------------------------------------------------------------

  /** Refresh session/branch identity (wired at session_start / session_tree). */
  refreshIdentity(sessionId: string, branchId?: string): void {
    this.sessionId = sessionId;
    this.branchId = branchId;
  }

  private excluded(text: string): boolean {
    for (const { rule, regex } of this.exclusions) {
      if (rule.project !== undefined && rule.project !== this.scope) continue;
      if (rule.pathPrefix !== undefined) continue;
      if (regex !== undefined && !regex.test(text)) continue;
      return true;
    }
    return false;
  }

  /**
   * Runs one capture flush over the delivered session entries. Entries the
   * coverage cursor already consumed are skipped; the rest are redacted,
   * chunked and durably enqueued (chunks + manifest). Entries whose
   * redaction fails stay uncovered (fail closed) and are reported.
   */
  capture(entries: readonly unknown[]): BackupCaptureResult {
    if (this.privateMode()) {
      // Private mode: no new capture/backup jobs (§5). Pending jobs are held
      // by the outbox, never deleted.
      this.auditEvent("held (private mode)");
      return {
        enqueuedChunks: 0,
        enqueuedManifest: false,
        heldEntries: 0,
        skippedReason: "private-mode",
      };
    }
    if (!this.exclusionsValid) {
      this.auditEvent("held (invalid exclusions)");
      return {
        enqueuedChunks: 0,
        enqueuedManifest: false,
        heldEntries: 0,
        skippedReason: "no-candidates",
        ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      };
    }
    const session = this.sessionState(this.sessionId);
    const covered = new Set(session.coveredEntryIds);
    const views = toBackupViews(entries);
    const fresh: BackupView[] = [];
    const seenInThisFlush = new Set<string>();
    for (const view of views) {
      if (covered.has(view.id) || seenInThisFlush.has(view.id)) continue;
      seenInThisFlush.add(view.id);
      fresh.push(view);
    }
    if (fresh.length === 0) {
      this.auditEvent("skipped (no candidates)");
      return {
        enqueuedChunks: 0,
        enqueuedManifest: false,
        heldEntries: 0,
        skippedReason: "no-candidates",
      };
    }

    // Policy split: excluded/extension-internal → omissions; redactable
    // text → chunks (after redaction). Binary omissions ride along on
    // otherwise-text entries.
    const chunkCandidates: BackupEntry[] = [];
    const omissions: ManifestOmission[] = [];
    const coveredNow: string[] = [];
    const redactionCounts: Record<string, number> = {
      ...session.redactionCounts,
    };
    let lastError: string | undefined;

    for (const view of fresh) {
      if (view.omissions.includes("extension-internal")) {
        omissions.push({ entryId: view.id, reason: "extension-internal" });
        coveredNow.push(view.id);
        continue;
      }
      const text = view.text;
      if (text === undefined) {
        // No text: binary-only or metadata shell. Omissions carry the record.
        for (const reason of view.omissions) {
          omissions.push({ entryId: view.id, reason });
        }
        if (view.omissions.length === 0) {
          omissions.push({ entryId: view.id, reason: "contentless-entry" });
        }
        coveredNow.push(view.id);
        continue;
      }
      if (this.excluded(text)) {
        omissions.push({ entryId: view.id, reason: "excluded-by-policy" });
        coveredNow.push(view.id);
        continue;
      }
      const r = this.redact(text);
      if (!r.ok) {
        // Fail closed: the entry stays uncovered (re-derived later), never
        // sent raw; a visible error is recorded for status output.
        lastError = `redaction-held (${r.reason})`;
        continue;
      }
      chunkCandidates.push({
        id: view.id,
        parentId: view.parentId,
        type: view.type,
        timestamp: view.timestamp,
        ...(view.role !== undefined ? { role: view.role } : {}),
        text: r.content,
        omissions: [...view.omissions],
      });
      coveredNow.push(view.id);
      for (const reason of view.omissions) {
        omissions.push({ entryId: view.id, reason });
      }
    }
    // Redaction counts come from the redactor at the model edge elsewhere;
    // here we count placeholders per chunk candidate (counts by type, never
    // values — §7). This keeps the manifest summary self-consistent with the
    // chunk bytes actually written.
    for (const entry of chunkCandidates) {
      for (const m of entry.text?.matchAll(/\[REDACTED:([a-z0-9-]+):\d+\]/g) ??
        []) {
        const type = m[1] ?? "unknown";
        redactionCounts[type] = (redactionCounts[type] ?? 0) + 1;
      }
    }

    const drafts = chunkEntries(this.sessionId, chunkCandidates, {
      seqStart: session.nextSeq,
      ...(this.maxChunkBytes !== undefined
        ? { maxChunkBytes: this.maxChunkBytes }
        : {}),
    });

    let enqueued = 0;
    for (const draft of drafts) {
      const sources = [
        {
          sessionId: this.sessionId,
          ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
          entryIds: draft.entryIds,
        },
      ];
      // The outbox mints the opId and has it on disk BEFORE enqueue
      // returns — no side effect precedes durability (decisions.md #8 / §2).
      this.outbox.enqueue({
        kind: "backup-chunk",
        scope: this.scope,
        idempotencyKey: idempotencyKey({
          kind: "backup-chunk",
          scope: this.scope,
          sources,
          tokens: [String(draft.seq)],
        }),
        payload: {
          type: "chunk",
          sessionId: this.sessionId,
          ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
          seq: draft.seq,
          entryIds: draft.entryIds,
          content: draft.content,
          checksum: draft.checksum,
        } satisfies BackupChunkPayload,
      });
      enqueued += 1;
      session.chunks.push({
        seq: draft.seq,
        path: backupChunkPath(this.projectId, this.sessionId, draft.seq),
        checksum: draft.checksum,
        byteLength: draft.byteLength,
        entryIds: [...draft.entryIds],
        ...(draft.oversized ? { oversized: true } : {}),
      });
    }

    // Coverage cursor advances ONLY after every chunk job is durably queued
    // (decisions.md #8). A crash before this point re-derives the same
    // chunks (identical content → backend replay no-op).
    session.coveredEntryIds.push(...coveredNow);
    session.nextSeq += drafts.length;
    session.omissions.push(...omissions);
    session.redactionCounts = redactionCounts;

    let enqueuedManifest = false;
    if (drafts.length > 0) {
      const manifest = buildBackupManifest({
        sessionId: this.sessionId,
        projectId: this.projectId,
        scope: this.scope,
        chunks: [...session.chunks],
        redactionSummary: redactionCounts,
        omissions: [...session.omissions],
        coveredEntryIds: session.coveredEntryIds,
        updatedAtMs: this.nowFn(),
      });
      this.outbox.enqueue({
        kind: "backup-chunk",
        scope: this.scope,
        idempotencyKey: idempotencyKey({
          kind: "backup-chunk",
          scope: this.scope,
          sources: [
            { sessionId: this.sessionId, entryIds: session.coveredEntryIds },
          ],
          tokens: ["manifest"],
        }),
        payload: {
          type: "manifest",
          sessionId: this.sessionId,
          manifest: serializeBackupManifest(manifest),
        } satisfies BackupManifestPayload,
      });
      enqueuedManifest = true;
    }

    this.persist();
    this.lastError = lastError;
    // Q04c: sanitized capture event (counts only — never entry content).
    const held = fresh.length - coveredNow.length;
    this.auditEvent(held > 0 ? "captured (with held entries)" : "captured", {
      byteCounts: {
        chunks: enqueued,
        held: held,
        omissions: omissions.length,
      },
    });
    return {
      enqueuedChunks: enqueued,
      enqueuedManifest,
      heldEntries: held,
      ...(lastError !== undefined ? { lastError } : {}),
    };
  }

  // ---- inspection -----------------------------------------------------------

  /** Durable chunk records for the session (manifest source of truth). */
  chunksFor(sessionId: string = this.sessionId): readonly ManifestChunk[] {
    return this.state.sessions[sessionId]?.chunks ?? [];
  }

  /** Derived manifest for the current session (or a specific session). */
  manifestFor(
    sessionId: string = this.sessionId,
  ): ReturnType<typeof buildBackupManifest> | undefined {
    const s = this.state.sessions[sessionId];
    if (!s) return undefined;
    return buildBackupManifest({
      sessionId,
      projectId: this.projectId,
      scope: this.scope,
      chunks: [...s.chunks],
      redactionSummary: s.redactionCounts,
      omissions: [...s.omissions],
      coveredEntryIds: s.coveredEntryIds,
      updatedAtMs: this.nowFn(),
    });
  }

  /** Covered entry count for the current session (coverage cursor size). */
  coveredCount(sessionId: string = this.sessionId): number {
    return this.state.sessions[sessionId]?.coveredEntryIds.length ?? 0;
  }

  /** Visible pending status (metadata only, never payload content). */
  pendingStatus(): string[] {
    const lines: string[] = [];
    if (this.lastError) {
      lines.push(`backup: held — ${this.lastError}`);
    }
    const session = this.state.sessions[this.sessionId];
    if (session && session.chunks.length > 0) {
      lines.push(
        `backup: ${session.chunks.length} chunk(s), ${session.coveredEntryIds.length} covered entries (session ${this.sessionId})`,
      );
    }
    return lines;
  }
}

export { BACKUP_SCHEMA_VERSION };
