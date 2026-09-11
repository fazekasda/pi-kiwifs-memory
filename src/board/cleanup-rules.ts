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
      reason: "not-owner" | "missing-basis" | "within-grace" | "malformed";
      detail: string;
    };

/**
 * Decides eligibility of ONE candidate against the §8 F8 / §13 row 13
 * contract, which is CONJUNCTIVE: own-sender AND client-TTL-expired AND
 * locally-acked AND older than the 30-day grace window. An earlier draft
 * of decisions.md #14 transcribed the middle conjuncts as "or" — that was
 * a transcription drift from the approved §8 text, not a broader approval;
 * this rule REQUIRES BOTH (expired-only and acked-only records are held,
 * never deleted). Fails closed on malformed timestamps or unknown schemas
 * — an uncertain timestamp is NEVER treated as "old enough".
 *
 * Grace semantics (documented, test-pinned):
 * - TTL basis: the message must have EXPIRED at least GRACE ago (expiry
 *   instant = created + ttl; the message was deliverable until then).
 * - Ack basis: grace also counts from the LOCAL ack instant.
 * - Both settled instants present (they must both be, for eligibility):
 *   the LATER one governs (conservative).
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

  // §8 F8 conjunction: BOTH the TTL-expiry AND a local ack by THIS agent
  // are required. A message that is expired-but-never-acked, or acked-but-
  // not-yet-expired, is HELD (conservative; deletion is never broadened
  // past the approved contract).
  if (!expired || ack.ackedAt === undefined) {
    return {
      eligible: false,
      reason: "missing-basis",
      detail:
        "eligibility requires BOTH client-TTL-expiry and a local ack by this agent " +
        (expired
          ? "(expired, but not acked by this consumer)"
          : "(locally acked but not yet client-TTL-expired)"),
    };
  }
  const basis: ("ttl-expired" | "locally-acked")[] = [
    "ttl-expired",
    "locally-acked",
  ];
  const settledAt = Math.max(expiryMs!, ack.ackedAt);
  if (now.getTime() - settledAt <= GC_GRACE_MS) {
    return {
      eligible: false,
      reason: "within-grace",
      detail: "not older than the 30-day grace window",
    };
  }
  return { eligible: true, basis, expired };
}
