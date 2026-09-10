/**
 * Q05R1: pure eligibility rules for manual remote board cleanup
 * (architecture.md §8 F8, §13 row 13, decisions.md #14).
 *
 * Kept separate from the planner so the boundaries (TTL edge, grace edge,
 * ownership, ack presence) are testable WITHOUT any network or repository.
 * All inputs are plain values; all outcomes are typed; nothing here can
 * delete anything (the module never touches an adapter).
 */

/**
 * §13 row 13 [P]: deleted messages must be older than a 30-day grace
 * window. The grace period is the compensating control for the accepted
 * limitation that another agent offline longer than the grace window may
 * lose a message this agent deletes (no shared delivery record over MCP,
 * so "acked by all consumers" is unverifiable).
 */
export const GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimal view of one freshly-read candidate (no body — never needed). */
export interface CandidateReadView {
  msgId: string;
  from: string;
  created: string;
  ttlSeconds: number | undefined;
}

/** Minimal view of THIS consumer's local ack state for one msgId. */
export interface LocalAckView {
  ackedAt: number | undefined;
}

export type CleanupEligibility =
  | {
      eligible: true;
      basis: ("ttl-expired" | "locally-acked")[];
      expired: boolean;
    }
  | {
      eligible: false;
      reason:
        | "not-owner"
        | "not-expired-and-not-acked"
        | "within-grace"
        | "malformed";
      detail: string;
    };

/**
 * Decides eligibility of ONE candidate against the §8 contract:
 * own-sender AND (client-TTL-expired OR locally-acked) AND older than the
 * 30-day grace window. Fails closed on malformed timestamps or unknown
 * schemas — an uncertain timestamp is NEVER treated as "old enough".
 *
 * Grace semantics (documented, test-pinned):
 * - TTL-expired basis: the message must have EXPIRED at least GRACE ago
 *   (expiry instant = created + ttl; grace counts from expiry, because the
 *   message was deliverable until then).
 * - Locally-acked basis: grace counts from the LOCAL ack instant.
 * - Both bases present: the LATER settled instant governs (conservative).
 * Boundary: exactly at the grace instant is NOT yet older (strict >).
 */
export function evaluateCleanupCandidate(
  read: CandidateReadView,
  ack: LocalAckView,
  ownFrom: string,
  now: Date,
): CleanupEligibility {
  if (read.from !== ownFrom) {
    return {
      eligible: false,
      reason: "not-owner",
      detail: "message was not sent by this agent's identity",
    };
  }
  const createdMs = Date.parse(read.created);
  if (!Number.isFinite(createdMs)) {
    // Fail closed: an unparseable created instant must never become a
    // delete candidate (uncertain timestamp → refuse).
    return {
      eligible: false,
      reason: "malformed",
      detail: "created instant is not a parseable timestamp",
    };
  }
  const ttl = read.ttlSeconds;
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) {
    return {
      eligible: false,
      reason: "malformed",
      detail: "ttl is not a finite non-negative number",
    };
  }
  const expiryMs = ttl !== undefined ? createdMs + ttl * 1000 : undefined;
  const expired = expiryMs !== undefined && expiryMs < now.getTime();

  const basis: ("ttl-expired" | "locally-acked")[] = [];
  let settledAt: number | undefined;
  if (expired) {
    basis.push("ttl-expired");
    settledAt = expiryMs;
  }
  if (ack.ackedAt !== undefined) {
    basis.push("locally-acked");
    settledAt =
      settledAt === undefined ? ack.ackedAt : Math.max(settledAt, ack.ackedAt);
  }
  if (basis.length === 0) {
    return {
      eligible: false,
      reason: "not-expired-and-not-acked",
      detail: "message is neither client-TTL-expired nor locally acked",
    };
  }
  if (settledAt === undefined || now.getTime() - settledAt <= GC_GRACE_MS) {
    return {
      eligible: false,
      reason: "within-grace",
      detail: "not older than the 30-day grace window",
    };
  }
  return { eligible: true, basis, expired };
}
