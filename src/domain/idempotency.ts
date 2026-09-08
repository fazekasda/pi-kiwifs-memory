/**
 * T05: deterministic idempotency keys (PRD T05, architecture.md §2).
 *
 * An idempotency key identifies a logical mutation independently of when or
 * how many times it is attempted:
 *
 * - Repeating the same event (same kind, scope and source provenance) yields
 *   the same key, so a replayed job re-derives the same deterministic path.
 * - Forked/shared history yields distinct keys: the key includes the
 *   sessionId (a fork mints a new sessionId even when entry history is
 *   shared), so a fork producing byte-identical content never collides with
 *   the parent's record — and per architecture.md §2, no content hash is
 *   ever used as identity.
 *
 * The key is NOT the opId: the opId is randomly unique and persisted before
 * any side effect (src/backend/opid.ts); the idempotency key is the stable
 * fingerprint that ties a re-derived job back to the same logical work.
 */

import { createHash } from "node:crypto";
import type { SourceRef } from "./records.ts";

export type IdempotentKind =
  | "observation"
  | "reflection"
  | "proposal"
  | "backup-chunk"
  | "board-message"
  | "forget";

export interface IdempotencyInput {
  kind: IdempotentKind;
  scope: string;
  /** Ordered provenance; order is part of the identity of the work. */
  sources: SourceRef[];
  /** Board messages: channel is part of the routing identity. */
  channel?: string;
  /**
   * Additional identity tokens (T11): reflections are keyed by the hash of
   * the observation set they summarize; merge proposals by the reflection
   * set plus the sorted target record ids. The key is a stable fingerprint:
   * duplicate batches yield the SAME key, so a re-derived job replays at the
   * same deterministic path. The outbox itself does NOT dedupe by key — the
   * one-logical-job guarantee is enforced upstream (reflection engine's
   * durable processed-set registry + seen-record dedupe) and at delivery
   * (deterministic-path `writeImmutable` replay no-op).
   */
  tokens?: string[];
}

/** Stable JSON: object keys sorted recursively, arrays preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Deterministic idempotency key: first 32 hex chars of SHA-256 over the
 * canonical form of `{kind, scope, channel?, sources}`.
 */
export function idempotencyKey(input: IdempotencyInput): string {
  const payload = {
    kind: input.kind,
    scope: input.scope,
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    sources: input.sources,
  };
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex")
    .slice(0, 32);
}

/** Stable record id derived from a persisted opId (first 16 hex chars). */
export function deriveRecordId(kind: IdempotentKind, opId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(opId)) {
    throw new Error(`opId must be a persisted UUID: ${opId}`);
  }
  return createHash("sha256")
    .update(`${kind}/${opId}`)
    .digest("hex")
    .slice(0, 16);
}
