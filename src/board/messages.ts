/**
 * T16: board message schema and client-side policy (PRD T16, architecture.md
 * §2/§8, mcp-contracts.md §5).
 *
 * A board message is an immutable markdown record (T05 `board-message` type)
 * stored at `board/{channel}/{msg_id}.md` where `msg_id` is hex-truncated
 * SHA-256 of `channel + "/" + from + "/" + opId` (src/backend/ids.ts). The
 * opId — never content — disambiguates concurrent senders, so two agents
 * sending identical payloads persist as distinct messages, while a replayed
 * job re-derives the same path and read-before-write no-ops.
 *
 * Untrusted data rules (decisions.md #4): message bodies are opaque data.
 * Nothing in this module parses them as commands, and no path here ever
 * leads to execution — bodies are returned verbatim to the caller (a tool /
 * the T17 delivery layer), never interpreted.
 *
 * Policy disclosures that are true of the backend and MUST NOT be claimed
 * otherwise anywhere in the UI:
 * - Single shared apikey: `to`/`from`/`channel` are routing labels, not
 *   confidentiality. Any holder of the key can read every channel.
 * - B5: no server-side TTL — expiry is enforced here, client-side, at read
 *   time (`created + ttl < now` → skipped as expired).
 */

import { deriveMsgId, deriveMsgPath } from "../backend/ids.ts";
import { PathEscapeError, validateId } from "../domain/paths.ts";
import {
  parseStoredRecord,
  serializeStoredRecord,
  type StoredRecord,
} from "../domain/records.ts";

/** Routing labels only — never confidentiality (shared-key backend). */
export const BOARD_ROUTING_IS_NOT_CONFIDENTIAL = true as const;

/** Validated identity of the sending agent (T03-derived or explicit alias). */
export interface BoardSender {
  /** Agent id; must match the strict id grammar. */
  from: string;
}

export interface BoardMessageInput {
  /** Channel name (created implicitly on first write; §13 row 17). */
  channel: string;
  /** Sending agent id. */
  from: string;
  /** Recipient agent id (routing label only). */
  to: string;
  /** Optional client-side TTL in seconds; absent = never expires locally. */
  ttlSeconds?: number;
  /** Message body (opaque markdown; redacted before any wire use). */
  body: string;
  /**
   * Creation instant. MUST be carried in the persisted outbox payload so a
   * replayed job re-derives byte-identical content (read-before-write no-op).
   * Callers that omit it get a fresh timestamp — correct for first send,
   * but a replay then collides and fails closed, which is why the outbox
   * job must always persist `created` (T16 integration note for T07).
   */
  created?: Date;
}

export interface BuiltBoardMessage {
  msgId: string;
  path: string;
  content: string;
}

/** Validates board identity fields against the strict id grammar. */
export function validateBoardIdentities(
  channel: string,
  from: string,
  to: string,
): void {
  validateId("channel", channel);
  validateId("from", from);
  validateId("to", to);
}

/**
 * Builds the deterministic message path and wire content. `opId` must be the
 * opId durably persisted at outbox enqueue (architecture.md §2) — this
 * function deliberately does not mint ids, so a re-derived job reproduces
 * the same `msg_id`.
 */
export function buildBoardMessage(
  input: BoardMessageInput,
  opId: string,
  created: Date = new Date(),
): BuiltBoardMessage {
  validateBoardIdentities(input.channel, input.from, input.to);
  if (typeof input.body !== "string") {
    throw new PathEscapeError("board message body must be a string");
  }
  const msgId = deriveMsgId(input.channel, input.from, opId);
  const path = deriveMsgPath(input.channel, input.from, opId);
  const record: StoredRecord = {
    frontmatter: {
      schemaVersion: 1,
      // T05 record id; for board messages the msgId is the identity that
      // matters on the wire — keep them equal so status output is unambiguous.
      id: msgId,
      type: "board-message",
      scope: "personal",
      created: (input.created ?? created).toISOString(),
      sources: [],
      status: "active",
      to: input.to,
      from: input.from,
      channel: input.channel,
      ttl: input.ttlSeconds !== undefined ? String(input.ttlSeconds) : "",
    },
    body: input.body,
  };
  return { msgId, path, content: serializeStoredRecord(record) };
}

export type ParsedBoardMessage =
  | { ok: true; message: StoredRecord; expired: boolean }
  | {
      ok: false;
      reason: "malformed" | "future-version" | "unsupported-version";
      detail: string;
    };

/**
 * Parses a freshly read board file. Expiry is client-side at read time (B5):
 * a message whose `created + ttl` has passed parses successfully but reports
 * `expired: true` so callers skip it visibly instead of silently hiding it.
 * The body is never inspected for instructions — data only.
 */
export function parseBoardMessage(
  content: string,
  now: Date = new Date(),
): ParsedBoardMessage {
  const parsed = parseStoredRecord(content);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, detail: parsed.detail };
  }
  const fm = parsed.record.frontmatter;
  if (fm.type !== "board-message") {
    return {
      ok: false,
      reason: "malformed",
      detail: `record at a board path is type ${fm.type}, not board-message`,
    };
  }
  let expired = false;
  if (fm.ttl !== undefined && fm.ttl !== "") {
    const ttlSeconds = Number(fm.ttl);
    if (Number.isFinite(ttlSeconds) && ttlSeconds >= 0) {
      const createdMs = Date.parse(fm.created);
      if (Number.isFinite(createdMs)) {
        expired = createdMs + ttlSeconds * 1000 < now.getTime();
      }
    }
  }
  return { ok: true, message: parsed.record, expired };
}

/** Client-side TTL predicate used by listing/delivery (architecture.md §8). */
export function isExpired(
  createdIso: string,
  ttlSeconds: number | undefined,
  now: Date = new Date(),
): boolean {
  if (ttlSeconds === undefined) return false;
  const createdMs = Date.parse(createdIso);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs + ttlSeconds * 1000 < now.getTime();
}
