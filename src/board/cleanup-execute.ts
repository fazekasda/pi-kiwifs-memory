/**
 * Q05R2: guarded delete executor for manual remote board cleanup
 * (architecture.md §8 F8, §13 row 13; decisions.md #14).
 *
 * Consumes an EXACT CleanupPreview produced by planBoardCleanup (Q05R1).
 * The preview is a proposal, NOT a capability: before EACH delete the
 * executor re-runs fresh read / ownership / path / TTL / ack / grace /
 * privacy checks and binds to the exact {msgId, path, created} tuple from
 * the preview. Anything that changed, or any check that cannot be
 * completed, is skipped VISIBLY — never force-deleted, never broadened.
 *
 * Hard disclosure contract (must stay true, test-pinned):
 * - MCP has NO compare-and-swap: between the fresh recheck read and
 *   `kiwi_delete` the message may change or vanish. The read-delete race
 *   is UNAVOIDABLE and is disclosed in every result; atomicity is never
 *   claimed.
 * - Deletion is MCP-level only (B6): no history/index/backup purge is
 *   performed or claimed, "acked by all consumers" is unverifiable, and
 *   no secure-erasure claim may ever be made.
 * - Recipient routing labels are not confidentiality; ownership checks are
 *   client policy, not tenant security.
 * - Local ack state is NEVER modified by this module: a partial failure
 *   leaves ack state exactly as it was (delete is idempotent — a replay
 *   re-detects eligibility from unchanged local state).
 * - A private-mode transition aborts the run immediately (no further
 *   deletes); already-deleted paths and remaining skips are reported.
 * - Never runs automatically: the caller must present the preview to the
 *   user and pass the user-confirmed preview here. This module performs no
 *   confirmation UI of its own.
 */

import { CancelledError } from "../backend/errors.ts";
import type { KiwiFSAdapter } from "../backend/adapter.ts";
import type { OpIdLedger } from "../backend/opid.ts";
import { mintOpId } from "../backend/opid.ts";
import { PrivateModeActiveError } from "../privacy/private-mode.ts";
import {
  evaluateCleanupCandidate,
  type CandidateReadView,
} from "./cleanup-rules.ts";
import { boardMsgIdOfPath, type BoardRepository } from "./repository.ts";
import type {
  CleanupPreview,
  CleanupPreviewFailure,
  CleanupPreviewItem,
} from "./cleanup.ts";
import type { LocalAckLookup } from "./cleanup.ts";

export const NO_CAS_DISCLOSURE =
  "no compare-and-swap over MCP: the message may change or vanish between the " +
  "final recheck read and the delete — this race is unavoidable and no atomicity " +
  "is claimed; deletion is MCP-level only (no history/index/backup purge, no " +
  "secure erasure, and no all-consumer-ack claim is possible or made)";

/** One message actually deleted (exact preview binding echoed back). */
export interface CleanupDeleted {
  msgId: string;
  path: string;
  /** opId persisted BEFORE the side effect (durable-replay identity). */
  opId: string;
}

/** A preview candidate that was NOT deleted, with a visible reason. */
export interface CleanupExecuteSkip {
  msgId: string | undefined;
  path: string;
  reason:
    | CleanupPreviewSkipReason
    | "changed"
    | "delete-failed"
    | "bound-exceeded"
    | "id-mismatch";
  /** Short sanitized detail; never message body content, never a raw path. */
  detail: string;
}

type CleanupPreviewSkipReason =
  | "not-owner"
  | "missing-basis"
  | "within-grace"
  | "expired"
  | "missing"
  | "malformed"
  | "future-version"
  | "unsupported-version"
  | "out-of-channel"
  | "bad-request"
  | "unavailable";

export interface CleanupExecution {
  ok: true;
  /** Messages actually deleted, in preview order (exact binding echoed). */
  deleted: CleanupDeleted[];
  /** Preview candidates not deleted, each with a visible reason. */
  skipped: CleanupExecuteSkip[];
  /** Stopped early because the caller's AbortSignal fired or private mode
   * activated mid-run — remaining candidates were NOT examined. */
  aborted: boolean;
  /** The maxDeletes bound stopped further deletes. */
  deletedBoundHit: boolean;
  /** opIds durably recorded whose `kiwi_delete` outcome is UNKNOWN (the call
   * was cancelled after the ledger persist, so the delete may or may not have
   * applied remotely; re-plan replay re-checks idempotently). opIds only —
   * never paths or bodies. */
  unknownDeleteOpIds: string[];
  ownFrom: string;
  /** Fixed disclosure text (NO_CAS_DISCLOSURE) — always present, never hidden. */
  disclosure: string;
}

export type CleanupExecutionRefused = {
  ok: false;
  reason: "no-preview" | "identity-changed" | "no-identity" | "private-mode";
  detail: string;
  /** Deletes completed before the refusal (empty for upfront refusals). */
  deleted: CleanupDeleted[];
  /** opIds persisted whose delete outcome is unknown (see CleanupExecution). */
  unknownDeleteOpIds?: string[];
};

export interface ExecuteCleanupOptions {
  /** Must equal preview.ownFrom; a mismatch refuses without any delete. */
  ownFrom: string;
  /** Fresh view of THIS consumer's local ack state (never mutated here). */
  acked: LocalAckLookup;
  /** Adapter used for the actual `kiwi_delete` calls. */
  adapter: KiwiFSAdapter;
  /** Ledger the executor records each minted opId into BEFORE the delete. */
  ledger: OpIdLedger;
  /** Bound on deletes per run (default 100). Excess → visible bound-exceeded. */
  maxDeletes?: number;
  /** Live private-mode gate; checked before EVERY delete and aborts the run. */
  privateMode?: { isPrivate: boolean } | undefined;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Executes a user-confirmed cleanup preview against the board. Performs
 * ONLY the deletes the exact preview contains, after a fresh per-candidate
 * recheck. Throws nothing for domain outcomes; results classify partial
 * failures with sanitized details (error names, never bodies or paths).
 */
export async function executeBoardCleanup(
  repo: BoardRepository,
  preview: CleanupPreview | CleanupPreviewFailure,
  opts: ExecuteCleanupOptions,
): Promise<CleanupExecution | CleanupExecutionRefused> {
  const deleted: CleanupDeleted[] = [];
  if (!preview.ok) {
    return {
      ok: false,
      reason: "no-preview",
      detail:
        "the supplied preview failed planning; there is nothing confirmed to execute",
      deleted,
    };
  }
  const ownFrom = opts.ownFrom;
  if (typeof ownFrom !== "string" || ownFrom.length === 0) {
    return {
      ok: false,
      reason: "no-identity",
      detail:
        "execution requires the configured board sender identity; refusing to guess ownership",
      deleted,
    };
  }
  // Exact-preview binding: the executing identity must be the identity the
  // preview was planned against. Never broaden after confirmation.
  if (ownFrom !== preview.ownFrom) {
    return {
      ok: false,
      reason: "identity-changed",
      detail:
        "current identity differs from the preview's identity; re-plan before executing",
      deleted,
    };
  }
  if (opts.privateMode?.isPrivate) {
    return {
      ok: false,
      reason: "private-mode",
      detail: "private mode is active — board deletes refused",
      deleted,
    };
  }

  const maxDeletes = Math.max(1, opts.maxDeletes ?? 100);
  const now = opts.now ?? new Date();
  const skipped: CleanupExecuteSkip[] = [];
  let aborted = false;
  const unknownDeleteOpIds: string[] = [];
  let privateTransition = false;
  let deletedBoundHit = false;

  for (const item of preview.candidates) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    if (opts.privateMode?.isPrivate) {
      privateTransition = true;
      break;
    }
    if (deleted.length >= maxDeletes) {
      deletedBoundHit = true;
      break;
    }
    // Path integrity: the preview path must still carry the exact preview
    // msg_id. A mismatch means the preview is stale or fabricated — fail
    // closed, never delete on an unconfirmed path.
    const pathMsgId = boardMsgIdOfPath(item.path);
    if (pathMsgId === undefined || pathMsgId !== item.msgId) {
      skipped.push({
        msgId: pathMsgId,
        path: item.path,
        reason: "id-mismatch",
        detail: "preview path no longer carries the previewed msg_id",
      });
      continue;
    }
    // Fresh recheck read (the preview is a proposal, not a capability).
    let read: Awaited<ReturnType<BoardRepository["read"]>>;
    try {
      read = await repo.read(item.path, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        includeExpired: true,
      });
    } catch (err) {
      if (err instanceof PrivateModeActiveError) {
        privateTransition = true;
        break;
      }
      if (err instanceof CancelledError) {
        aborted = true;
        break;
      }
      skipped.push({
        msgId: item.msgId,
        path: item.path,
        reason: "unavailable",
        detail: `recheck read failed: ${(err as Error).name}`,
      });
      continue;
    }
    if (!read.ok) {
      skipped.push({
        msgId: item.msgId,
        path: item.path,
        reason: read.reason,
        detail: `recheck read ineligible: ${read.detail}`,
      });
      continue;
    }
    // Exact binding: msgId AND created must still match the preview; the
    // sender must still be this identity. Any drift → skip, never delete.
    if (
      read.msgId !== item.msgId ||
      read.created !== item.created ||
      read.from !== ownFrom
    ) {
      skipped.push({
        msgId: read.msgId,
        path: item.path,
        reason: "changed",
        detail:
          "message changed since the confirmed preview (id/created/sender); re-plan required",
      });
      continue;
    }
    // Fresh CONTENT identity, where the backend metadata allows it: when the
    // preview observed a `kiwi.etag`, the recheck read must still carry the
    // SAME etag (present AND equal). A changed or vanished etag means the
    // content moved under a stable id/created/from — skip, never delete.
    // When the backend supplied NO etag at preview time, binding stays on
    // the exact tuple above; no CAS is invented.
    if (item.etag !== undefined && read.etag !== item.etag) {
      skipped.push({
        msgId: read.msgId,
        path: item.path,
        reason: "changed",
        detail:
          "content identity changed since the confirmed preview (etag drift); re-plan required",
      });
      continue;
    }
    // Full eligibility recheck against FRESH state: the §8 conjunction
    // (expired AND locally-acked) and the 30-day grace are re-evaluated
    // NOW, not inherited from the preview.
    const ackedAt = opts.acked(item.msgId);
    const view: CandidateReadView = {
      msgId: read.msgId,
      from: read.from,
      created: read.created,
      ttlSeconds: read.ttlSeconds,
    };
    const eligibility = evaluateCleanupCandidate(
      view,
      { ackedAt },
      ownFrom,
      now,
    );
    if (!eligibility.eligible) {
      skipped.push({
        msgId: item.msgId,
        path: item.path,
        reason: eligibility.reason,
        detail: eligibility.detail,
      });
      continue;
    }
    // Persist-before-side-effect: mint and record the opId BEFORE adapter.del.
    const opId = mintOpId();
    opts.ledger.record(opId);
    try {
      await opts.adapter.del(item.path, {
        opId,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        aborted = true;
        // The opId was already durably persisted, so the remote delete may
        // or may not have applied: disclose it as unknown, never omit it.
        unknownDeleteOpIds.push(opId);
        break;
      }
      if (err instanceof PrivateModeActiveError) {
        privateTransition = true;
        unknownDeleteOpIds.push(opId);
        break;
      }
      skipped.push({
        msgId: item.msgId,
        path: item.path,
        reason: "delete-failed",
        detail: `kiwi_delete failed: ${(err as Error).name}`,
      });
      continue;
    }
    deleted.push({ msgId: item.msgId, path: item.path, opId });
  }

  // A private-mode transition MID-RUN is a hard stop reported as a refusal
  // with the partial deletes disclosed (never silently swallowed).
  if (privateTransition) {
    return {
      ok: false,
      reason: "private-mode",
      detail:
        "private mode became active during execution; stopped before further deletes" +
        (unknownDeleteOpIds.length > 0
          ? `; ${unknownDeleteOpIds.length} delete(s) already issued have UNKNOWN remote outcome (opIds: ${unknownDeleteOpIds.join(",")})`
          : ""),
      deleted,
      ...(unknownDeleteOpIds.length > 0 ? { unknownDeleteOpIds } : {}),
    };
  }

  return {
    ok: true,
    deleted,
    skipped,
    aborted,
    deletedBoundHit,
    unknownDeleteOpIds,
    ownFrom,
    disclosure: NO_CAS_DISCLOSURE,
  };
}

export type { CleanupPreviewItem, CleanupPreviewFailure };
