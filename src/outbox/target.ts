/**
 * Q07C: enqueue-time delivery-target fingerprint (Q07A §3 queue-hazard
 * contract). A persisted job records WHICH delivery target it was minted
 * for — endpoint URL + credential-reference identity + record scope — so a
 * session-boundary rebuild against a CHANGED target can never silently
 * reroute retained jobs to the new target. Mismatch ⇒ the worker HELDS the
 * job visibly (pending, original opId, never delivered, never dropped,
 * never quarantined).
 *
 * Why a hash: the journal must never gain a secret-bearing or even
 * endpoint-revealing field just for this check, so the composite is hashed
 * (sha-256 hex). The credential VALUE never enters the fingerprint — only
 * the reference identity (env name / file path) — so rotating the secret
 * behind the SAME reference does not change the target: delivery proceeds
 * (contract §3). Only a url change, a reference-identity change, or a
 * record-scope change holds.
 *
 * No user content is carried by this module.
 */

import { createHash } from "node:crypto";
import type { AuthRef } from "../config/schema.ts";

/**
 * Stable, secret-free identity of a delivery target for one record scope.
 * Deterministic across processes and rebuilds (pure function of config
 * identity + scope, never of time or resolved secret values).
 */
export function targetFingerprint(
  url: string,
  auth: AuthRef | undefined,
  scope: string,
): string {
  return createHash("sha256")
    .update(`${url}\n${auth ? JSON.stringify(auth) : "-"}\n${scope}`)
    .digest("hex");
}
