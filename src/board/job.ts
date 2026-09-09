/**
 * T16: board-message outbox jobs (architecture.md §2/§6/§8, PRD T16).
 *
 * Board sends ride the SAME durable outbox as observation/backup jobs:
 * - The opId is assigned and persisted at enqueue (decisions.md #8) BEFORE
 *   any network side effect — a replayed job reproduces the same
 *   op-derived msg path (B2 read-before-write no-op).
 * - `created` is persisted in the payload at enqueue time (T16 chunk-1
 *   integration contract): the sender must re-derive byte-identical wire
 *   content from the payload alone, never from a wall-clock read.
 * - Payloads reach the queue only AFTER the privacy redactor accepted the
 *   body (privacy.md: the redaction gate sits on every outbound edge, and
 *   the outbox's own secret screening re-checks enqueue-side).
 * - The job payload is re-validated at delivery time; a malformed or
 *   tampered payload is a typed permanent failure → visible quarantine,
 *   never a crash and never a silent skip.
 *
 * Delivery failure discipline: the sender NEVER deletes or rewrites a
 * message. A differing-content collision at the deterministic path is a
 * permanent failure (quarantined, visible status) — no CAS, no overwrite.
 */

import type { OutboxJob } from "../outbox/store.ts";
import { ConflictError, ValidationError } from "../backend/errors.ts";
import { validateId } from "../domain/paths.ts";
import {
  buildBoardMessage,
  validateBoardIdentities,
  type BoardMessageInput,
} from "./messages.ts";

/** Outbox job payload for one board message (redacted before enqueue). */
export interface BoardMessagePayload {
  opId: string;
  channel: string;
  from: string;
  to: string;
  /** Already-redacted body (enqueue gate); treated as opaque data. */
  body: string;
  ttlSeconds?: number;
  /** ISO instant fixed at enqueue — required for replay determinism. */
  created: string;
}

/** Validates a board job payload; typed permanent failure on violation. */
export function parseBoardPayload(job: OutboxJob): BoardMessagePayload {
  const p = job.payload as Partial<BoardMessagePayload> | null;
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.opId !== "string" ||
    p.opId !== job.opId ||
    typeof p.channel !== "string" ||
    typeof p.from !== "string" ||
    typeof p.to !== "string" ||
    typeof p.body !== "string" ||
    typeof p.created !== "string" ||
    Number.isNaN(Date.parse(p.created))
  ) {
    throw new ValidationError(
      "board job payload is missing required fields (opId/channel/from/to/body/created)",
      "kiwi_write",
    );
  }
  if (p.ttlSeconds !== undefined && typeof p.ttlSeconds !== "number") {
    throw new ValidationError(
      "board job payload ttlSeconds must be a number",
      "kiwi_write",
    );
  }
  try {
    validateBoardIdentities(p.channel, p.from, p.to);
    validateId("channel", p.channel);
  } catch (err) {
    throw new ValidationError(
      `board job payload identity rejected: ${(err as Error).name}`,
      "kiwi_write",
    );
  }
  return p as BoardMessagePayload;
}

/**
 * Builds the deterministic wire content for one board job. `created` comes
 * from the durably persisted payload (never a wall-clock read): a replay of
 * the same job reproduces byte-identical content at the same path.
 */
export function buildBoardJobMessage(
  payload: BoardMessagePayload,
  opId: string,
): { path: string; content: string; msgId: string } {
  const input: BoardMessageInput = {
    channel: payload.channel,
    from: payload.from,
    to: payload.to,
    body: payload.body,
    ...(payload.ttlSeconds !== undefined
      ? { ttlSeconds: payload.ttlSeconds }
      : {}),
    created: new Date(payload.created),
  };
  const built = buildBoardMessage(input, opId, new Date(payload.created));
  return built;
}

/** Minimal backend surface the board sender needs (KiwiFSAdapter satisfies). */
export interface BoardDeliveryBackend {
  writeImmutable(
    path: string,
    content: string,
    opts: { opId: string; signal?: AbortSignal },
  ): Promise<{ replayed: boolean }>;
}

/**
 * Delivers one board job through the adapter's B2 read-before-write.
 * Throws on failure so the worker retries or quarantines per its rules:
 * availability → retryable; content collision → permanent (quarantined,
 * visible status, original message intact, never overwritten).
 */
export async function sendBoardJob(
  job: OutboxJob,
  backend: BoardDeliveryBackend,
): Promise<void> {
  const payload = parseBoardPayload(job);
  const built = buildBoardJobMessage(payload, job.opId);
  try {
    await backend.writeImmutable(built.path, built.content, {
      opId: job.opId,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ValidationError(
        "board message path conflict (differing content at the deterministic path) — original intact, quarantined",
        "kiwi_write",
      );
    }
    throw err;
  }
}
