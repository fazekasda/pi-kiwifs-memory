/**
 * Q05R1: manual remote board cleanup — eligibility rules and BOUNDED
 * READ-ONLY preview planner (architecture.md §8 F8, §13 row 13;
 * decisions.md #14).
 *
 * Scope of THIS module (read-only by construction — there is no delete
 * call anywhere in it):
 * - Decide which board messages THIS agent may propose for manual remote
 *   cleanup, per the §8 contract: sent by THIS agent's identity (`from`),
 *   client-TTL-expired (B5) OR locally acked by this agent, and older than
 *   the [P] 30-day grace window.
 * - Produce a preview of candidates with STABLE ids (the deterministic
 *   msg_id — SHA-256 of `channel/from/opId`, src/backend/ids.ts) bound to
 *   the EXACT path + created instant observed at preview time.
 * - Skip ineligible or unreadable records VISIBLY (never silently), and
 *   disclose bounded listings/reads as truncated.
 *
 * Contract for the FUTURE confirm/delete executor (not implemented here):
 * a confirmation must bind to the exact preview — same msgId, same path,
 * same created instant — and must NEVER broaden after confirmation. Before
 * EACH delete the executor must re-run fresh read/status/ownership/TTL/
 * ack/privacy checks; the preview is a proposal, not a capability.
 *
 * Disclosures that MUST be surfaced by any UI on top of this planner:
 * - Routing labels are not confidentiality (shared apikey backend); the
 *   ownership check is client policy, not tenant security.
 * - MCP has no compare-and-swap: between preview and delete the message
 *   may change or vanish. A read-delete race is UNAVOIDABLE — never claim
 *   atomicity. Concurrently changed/ineligible records must be skipped
 *   visibly, not force-deleted.
 * - Deletion is MCP-level only (B6): no history/index/backup purge is
 *   claimed, "acked by all consumers" is unverifiable, and no secure-
 *   erasure or all-consumer-ack claim may ever be made.
 * - Never run automatically; the user triggers each preview explicitly.
 */

import {
  GC_GRACE_MS,
  evaluateCleanupCandidate,
  type CandidateReadView,
  type CleanupEligibility,
} from "./cleanup-rules.ts";
import { boardMsgIdOfPath, type BoardRepository } from "./repository.ts";

export { GC_GRACE_MS };

/** A candidate that passed ALL eligibility checks at preview time. */
export interface CleanupPreviewItem {
  /** Stable preview id = msg_id (deterministic, replay-stable). */
  msgId: string;
  /** Exact observed path — the only path a confirmed delete may target. */
  path: string;
  channel: string;
  /** Observed sender (must equal the configured own identity). */
  from: string;
  to: string;
  /** ISO instant observed in the fresh read; binds the preview. */
  created: string;
  ttlSeconds: number | undefined;
  /** Why this candidate is eligible (both may apply). */
  basis: ("ttl-expired" | "locally-acked")[];
  /** True when created + ttl has passed (B5 client-side expiry). */
  expired: boolean;
  /** Epoch ms of the local ack, when the ack basis applies. */
  ackedAt: number | undefined;
}

/** A record inspected but NOT proposed, with a visible reason. */
export interface CleanupSkip {
  path: string;
  msgId: string | undefined;
  reason:
    | "not-owner"
    | "not-expired-and-not-acked"
    | "within-grace"
    | "id-mismatch"
    | "expired"
    | "missing"
    | "malformed"
    | "future-version"
    | "unsupported-version"
    | "out-of-channel"
    | "bad-request"
    | "unavailable";
  /** Short sanitized detail; never message body content. */
  detail: string;
}

export interface CleanupPreview {
  ok: true;
  /** Candidates eligible at preview time, in stable listing order. */
  candidates: CleanupPreviewItem[];
  /** Inspected-but-ineligible / unreadable records, with reasons. */
  skipped: CleanupSkip[];
  /** Bounded listing stopped early — more board messages may exist. */
  listingTruncated: boolean;
  /** Read bound hit before every listed path was inspected. */
  readTruncated: boolean;
  /** The own identity the plan was computed against. */
  ownFrom: string;
}

export type CleanupPreviewFailure = {
  ok: false;
  reason: "no-identity" | "bad-identity" | "listing-failed" | "private-mode";
  detail: string;
};

export interface PlanCleanupOptions {
  /**
   * THIS agent's board sender identity. Must be configured and grammar-
   * valid; the planner FAILS CLOSED without it (no heuristic ownership).
   */
  ownFrom: string;
  /**
   * Read-only view of THIS consumer's durable local delivery state (the
   * ack map). Acks are LOCAL state only; absence of an entry means
   * "not acked here" — never inferred from anything else.
   */
  acked: LocalAckLookup;
  /** Bound on candidates kept (default 200). */
  maxCandidates?: number;
  /** Bound on fresh reads performed per plan (default 500). */
  maxReads?: number;
  now?: Date;
  signal?: AbortSignal;
}

/** Acked lookup: msgId → local ack epoch ms (durable delivery state). */
export type LocalAckLookup = (msgId: string) => number | undefined;

/**
 * Plans a read-only cleanup preview. Performs ONLY reads: one bounded
 * `kiwi_query_meta` listing pass (via repo.listAllBoardMessagePaths) and
 * bounded fresh `kiwi_read`s. Throws nothing for domain outcomes; backend
 * availability faults on the LISTING surface as a typed failure (the
 * caller may retry), per-read faults become visible skips.
 */
export async function planBoardCleanup(
  repo: BoardRepository,
  opts: PlanCleanupOptions,
): Promise<CleanupPreview | CleanupPreviewFailure> {
  const ownFrom = opts.ownFrom;
  if (typeof ownFrom !== "string" || ownFrom.length === 0) {
    return {
      ok: false,
      reason: "no-identity",
      detail:
        "cleanup planning requires the configured board sender identity (board consumer/from); refusing to guess ownership",
    };
  }
  const maxCandidates = Math.max(1, opts.maxCandidates ?? 200);
  const maxReads = Math.max(1, opts.maxReads ?? 500);
  const now = opts.now ?? new Date();

  let listing: Awaited<ReturnType<BoardRepository["listAllBoardMessagePaths"]>>;
  try {
    listing = await repo.listAllBoardMessagePaths({
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (
      err !== undefined &&
      typeof err === "object" &&
      (err as { name?: string }).name === "PrivateModeActiveError"
    ) {
      return {
        ok: false,
        reason: "private-mode",
        detail: "private mode is active — board reads refused",
      };
    }
    return {
      ok: false,
      reason: "listing-failed",
      detail: `bounded board listing failed: ${(err as Error).name}`,
    };
  }

  const candidates: CleanupPreviewItem[] = [];
  const skipped: CleanupSkip[] = [];
  let readTruncated = false;

  for (const path of listing.paths) {
    if (candidates.length >= maxCandidates) {
      readTruncated = true;
      break;
    }
    if (skipped.length + candidates.length >= maxReads) {
      readTruncated = true;
      break;
    }
    // Path stem is the wire identity; a mismatch is a fail-closed skip
    // (never delete on a path whose id we could not confirm).
    const pathMsgId = boardMsgIdOfPath(path);
    if (pathMsgId === undefined) {
      skipped.push({
        path,
        msgId: undefined,
        reason: "id-mismatch",
        detail: "path does not carry a well-formed board msg_id",
      });
      continue;
    }
    let read: Awaited<ReturnType<BoardRepository["read"]>>;
    try {
      read = await repo.read(path, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        includeExpired: true,
      });
    } catch (err) {
      skipped.push({
        path,
        msgId: pathMsgId,
        reason: "unavailable",
        detail: `fresh read failed: ${(err as Error).name}`,
      });
      continue;
    }
    if (!read.ok) {
      skipped.push({
        path,
        msgId: pathMsgId,
        reason: read.reason,
        detail: read.detail,
      });
      continue;
    }
    const ackedAt = opts.acked(pathMsgId);
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
    if (eligibility.eligible) {
      candidates.push({
        msgId: read.msgId,
        path,
        channel: read.channel,
        from: read.from,
        to: read.to,
        created: read.created,
        ttlSeconds: read.ttlSeconds,
        basis: eligibility.basis,
        expired: eligibility.expired,
        ackedAt,
      });
    } else {
      skipped.push({
        path,
        msgId: read.msgId,
        reason: eligibility.reason,
        detail: eligibility.detail,
      });
    }
  }

  return {
    ok: true,
    candidates,
    skipped,
    listingTruncated: listing.truncated,
    readTruncated,
    ownFrom,
  };
}

export type { CleanupEligibility };
