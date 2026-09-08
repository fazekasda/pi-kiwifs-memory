/**
 * T04: deterministic identifiers derived from persisted opIds
 * (architecture.md §2, mcp-contracts.md §5/§9 fixture 5b).
 *
 * `msg_id` = first 16 hex chars of SHA-256 over the slash-joined
 * `'{channel}/{from}/{opId}'`. The opId (not content) disambiguates
 * concurrent senders; replays of the same job reproduce the same id.
 * The 16-hex truncation is a [P] default (architecture.md §2) — live
 * confirmation is a T04/T16 follow-up.
 */

import { createHash } from "node:crypto";

export const MSG_ID_HEX_CHARS = 16;

export function deriveMsgId(
  channel: string,
  from: string,
  opId: string,
): string {
  const h = createHash("sha256")
    .update(`${channel}/${from}/${opId}`)
    .digest("hex");
  return h.slice(0, MSG_ID_HEX_CHARS);
}

export function deriveMsgPath(
  channel: string,
  from: string,
  opId: string,
): string {
  return `board/${channel}/${deriveMsgId(channel, from, opId)}.md`;
}
