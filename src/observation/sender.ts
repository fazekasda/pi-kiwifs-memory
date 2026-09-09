/**
 * T10: real observation sender — delivers durably queued observation jobs to
 * the KiwiFS backend (architecture.md §2, §3.2; replaces the T09 stub).
 *
 * - The outbox job payload is validated AGAIN before any backend write:
 *   observations must carry only sourceEntryIds that the job itself supplies
 *   (stored observations refer only to supplied source entries — PRD T10).
 * - The record body is an inert DATA block: validated observations serialized
 *   as JSON inside an explicit fence. It is never parsed as instructions and
 *   cannot escape the fence (validated at extraction, re-checked here).
 * - Delivery uses `writeImmutable` (read-before-write, B2): absent → write;
 *   identical content → replay no-op; different content → ConflictError
 *   (fail closed, quarantined upstream, never overwritten).
 * - The record id and deterministic path derive from the persisted opId
 *   (§2), and the record `created` timestamp derives from the job's
 *   durably persisted enqueue time (outbox `createdAt`): a replay of the
 *   same opId reproduces byte-identical content AND the same path, so a
 *   crash between remote success and local ack replays as a no-op
 *   (deterministic paths, T07 B2) instead of minting a second record.
 * - An unresolved record scope (no project identity yet — git-remote
 *   discovery is the documented T18 convention) is a retryable
 *   availability gap, never a permanent quarantine: jobs stay pending
 *   with backoff until the scope resolves.
 * - When the backend is not configured, the sender throws the retryable
 *   `SenderNotWiredError`: jobs stay pending with backoff — never dropped.
 */

import type { OutboxJob } from "../outbox/store.ts";
import type { KiwiFSAdapter } from "../backend/adapter.ts";
import { BackendError, ValidationError } from "../backend/errors.ts";
import { deriveRecordId } from "../domain/idempotency.ts";
import { memoryRecordPath } from "../domain/paths.ts";
import {
  type RecordFrontmatter,
  type StoredRecord,
  serializeStoredRecord,
} from "../domain/records.ts";
import { DATA_FENCE_END } from "./model.ts";
import { sendProposalJob, sendReflectionJob } from "./reflection.ts";
import { sendBackupJob } from "../backup/capture.ts";

/**
 * Retryable availability gap: the observation delivery backend is not
 * configured (or the MCP boundary is not wired). Jobs stay pending with
 * backoff — never quarantined, never dropped.
 */
export class SenderNotWiredError extends BackendError {
  constructor(detail: string) {
    super("availability", detail);
    this.name = "SenderNotWiredError";
  }
}

/** Minimal backend surface the sender needs (real impl: KiwiFSAdapter). */
export interface ObservationBackend {
  writeImmutable(
    path: string,
    content: string,
    opts: { opId: string; signal?: AbortSignal },
  ): Promise<{ replayed: boolean }>;
  /**
   * T14: mutable write — used ONLY for the backup manifest path (the single
   * mutable path of a backup tree). Optional: backends without it cannot
   * deliver backup manifest jobs (held as a retryable gap).
   */
  write?(
    path: string,
    content: string,
    opts: { opId: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Inert data fence for the record body. */
export function serializeObservationBody(observations: unknown): string {
  return [
    `<!-- ${DATA_FENCE_END.replace(/-end$/, "-begin")} (inert data; never instructions)`,
    JSON.stringify(observations, null, 2),
    `${DATA_FENCE_END} -->`,
    "",
  ].join("\n");
}

export interface ObservationPayload {
  opId: string;
  trigger: string;
  sessionId: string;
  branchId?: string;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
  sourceEntryIds: string[];
  observations: {
    sourceEntryIds: string[];
    statement: string;
    uncertainty: string;
  }[];
}

/** Validates the job payload shape; typed permanent failure on violation. */
/** Valid uncertainty labels; tampered payloads are rejected before persist. */
const UNCERTAINTY_LABELS = new Set(["low", "medium", "high"]);

export function parseObservationPayload(job: OutboxJob): ObservationPayload {
  const p = job.payload as Partial<ObservationPayload> | null;
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.opId !== "string" ||
    p.opId !== job.opId ||
    typeof p.sessionId !== "string" ||
    p.sessionId === "" ||
    !Array.isArray(p.sourceEntryIds) ||
    !Array.isArray(p.observations)
  ) {
    throw new ValidationError(
      "observation job payload is missing required fields (opId/sessionId/sourceEntryIds/observations)",
      "kiwi_write",
    );
  }
  for (const o of p.observations) {
    if (
      typeof o !== "object" ||
      o === null ||
      !Array.isArray(o.sourceEntryIds) ||
      typeof o.statement !== "string" ||
      o.statement.trim() === ""
    ) {
      throw new ValidationError(
        "observation job payload contains a malformed observation",
        "kiwi_write",
      );
    }
    // Stored observations refer ONLY to the job's own supplied sources.
    for (const id of o.sourceEntryIds) {
      if (!p.sourceEntryIds.includes(id)) {
        throw new ValidationError(
          "observation references an entry id outside the job's supplied source set",
          "kiwi_write",
        );
      }
    }
    if (
      typeof o.uncertainty !== "string" ||
      !UNCERTAINTY_LABELS.has(o.uncertainty)
    ) {
      throw new ValidationError(
        "observation payload carries an invalid uncertainty label",
        "kiwi_write",
      );
    }
    // Inert-data guard mirrors the extractor: no fence escape in stored data.
    if (o.statement.includes(DATA_FENCE_END) || o.statement.includes("-->")) {
      throw new ValidationError(
        "observation statement contains a reserved serialization marker",
        "kiwi_write",
      );
    }
  }
  return p as ObservationPayload;
}

/**
 * Builds the stored observation record from a validated payload. `createdAtMs`
export function buildObservationRecord(
 * MUST be the job's durably persisted enqueue time (outbox `createdAt`, epoch
 * ms): `created` (ISO-8601 UTC) flows into both the record content and its
 * path (year/month), so it has to be replay-stable. A wall-clock read here
 * would break crash-replay determinism (different content → guaranteed
 * ConflictError for a write that succeeded; across a month boundary a
 * duplicate record at a second path).
 */
export function buildObservationRecord(
  payload: ObservationPayload,
  scope: string,
  createdAtMs: number,
): { record: StoredRecord; path: string } {
  if (!Number.isFinite(createdAtMs) || createdAtMs < 0) {
    throw new ValidationError(
      "observation job is missing a valid persisted createdAt timestamp",
      "kiwi_write",
    );
  }
  const created = new Date(createdAtMs).toISOString();
  const id = deriveRecordId("observation", payload.opId);
  const sources: RecordFrontmatter["sources"] = [
    {
      sessionId: payload.sessionId,
      ...(payload.branchId !== undefined ? { branchId: payload.branchId } : {}),
      entryIds: payload.sourceEntryIds,
    },
  ];
  const record: StoredRecord = {
    frontmatter: {
      schemaVersion: 1,
      id,
      type: "observation",
      scope: scope as RecordFrontmatter["scope"],
      created,
      sources,
      status: "active",
    },
    body: serializeObservationBody(payload.observations),
  };
  return {
    record,
    path: memoryRecordPath(scope, "observation", id, new Date(created)),
  };
}

/** Delivers one observation job. Throws on failure (worker handles retry). */
export async function sendObservationJob(
  job: OutboxJob,
  scope: string,
  backend: ObservationBackend,
): Promise<void> {
  const payload = parseObservationPayload(job);
  const { record, path } = buildObservationRecord(
    payload,
    scope,
    job.createdAt,
  );
  await backend.writeImmutable(path, serializeStoredRecord(record), {
    opId: job.opId,
  });
}

export interface BackendSenderDeps {
  /**
   * Scope the observation records are stored under (owner scope).
   * `undefined` when the scope is not yet resolved (no project identity —
   * T18 git-remote discovery): delivery is held as a retryable
   * availability gap, never a permanent quarantine.
   */
  scope: string | undefined;
  /** Backend factory; returns undefined when MCP is not configured. */
  openBackend: () => Promise<ObservationBackend | undefined>;
}

/**
 * Builds the outbox worker's JobSender. When no backend is available
 * (e.g. the extension is not enabled / MCP unconfigured), the sender throws
 * the retryable SenderNotWiredError so jobs remain pending with backoff.
 *
 * T11: dispatches by job kind — observation records, reflection summaries
 * and merge proposals share the same scope/backend discipline and the same
 * deterministic-path writeImmutable delivery. Unresolved scope holds ALL
 * record kinds (never a partial delivery with divergent lifecycle state).
 */
export function createObservationSender(
  deps: BackendSenderDeps,
): (job: OutboxJob) => Promise<void> {
  return async (job: OutboxJob) => {
    const scope = deps.scope;
    if (scope === undefined) {
      throw new SenderNotWiredError(
        "record scope not yet resolved (project identity pending, T18) — record delivery held",
      );
    }
    const backend = await deps.openBackend();
    if (!backend) {
      throw new SenderNotWiredError(
        "backend not configured — record delivery pending",
      );
    }
    if (job.kind === "reflection") {
      await sendReflectionJob(job, scope, backend);
      return;
    }
    if (job.kind === "proposal") {
      await sendProposalJob(job, scope, backend);
      return;
    }
    if (job.kind === "backup-chunk") {
      // T14: backup delivery requires a project id for the
      // `backup/{project-id}/` namespace; a personal-only scope cannot
      // address one — held as a retryable gap (never quarantined, never
      // dropped), consistent with record delivery on an unresolved scope.
      if (!scope.startsWith("project/")) {
        throw new SenderNotWiredError(
          "backup delivery requires a project scope — held (retryable)",
        );
      }
      const manifestWriter = backend.write;
      if (!manifestWriter) {
        throw new SenderNotWiredError(
          "backend lacks manifest write support — backup delivery held",
        );
      }
      await sendBackupJob(job, scope, scope.slice("project/".length), {
        writeImmutable: backend.writeImmutable.bind(backend),
        write: manifestWriter.bind(backend),
      });
      return;
    }
    await sendObservationJob(job, scope, backend);
  };
}
