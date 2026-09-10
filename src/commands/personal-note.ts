/**
 * Q05P1: explicit personal record creation — domain support only.
 *
 * Policy (docs/decisions.md #13, user-approved): `personal`-scope writes
 * exist ONLY via an explicit user action. Nothing writes `personal`
 * automatically; project-scoped observations are never auto-promoted. This
 * module builds the durable outbox job for ONE explicit user-supplied
 * statement; it performs no I/O, makes no model calls and is never invoked
 * by any automatic capture path. Command wiring (TUI + headless `--yes`
 * confirmation) is a separate later task.
 *
 * Reuse, not divergence: the job reuses the existing observation record
 * schema (kind "observation", scope "personal", `trigger: "manual"`), the
 * existing provenance shape (SourceRef), the existing deterministic
 * idempotency key (scope is part of the key, so a personal record never
 * collides with a project record) and the existing idempotent
 * `writeImmutable` delivery — including the durable-opId-before-side-effect
 * rule enforced by the outbox.
 */

import { randomUUID } from "node:crypto";
import { idempotencyKey } from "../domain/idempotency.ts";
import type { EnqueueInput } from "../outbox/store.ts";
import { DATA_FENCE_END } from "../observation/model.ts";
import type { ObservationPayload } from "../observation/sender.ts";

/** The single owner scope this module may ever target. */
export const PERSONAL_SCOPE = "personal";

/** Hard upper bound on an explicit personal statement (chars). */
export const PERSONAL_STATEMENT_MAX_CHARS = 8_000;

export interface ExplicitPersonalInput {
  /** Current session id (provenance; becomes the record's SourceRef). */
  sessionId: string;
  branchId?: string;
  /**
   * Entry ids the user explicitly attached via `--entry id1,id2`. Optional:
   * a personal note is the user's own words, so session-only provenance is
   * valid — entries are never invented by the command layer.
   */
  entryIds?: string[];
  /** The user's own words. Stored verbatim after fence/secret screening. */
  statement: string;
  /**
   * Test/determinism hook: minted opId. Omit in production (a fresh UUID is
   * used); the outbox persists the opId BEFORE any side effect either way.
   */
  opId?: string;
}

export class ExplicitPersonalInputError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ExplicitPersonalInputError";
  }
}

/**
 * Builds the durable enqueue input for one explicit personal record.
 * Rejects (before any durable write): empty/oversized statements, reserved
 * serialization markers and entry ids that are not strict-id-safe. An empty
 * `entryIds` is valid (provenance = the session SourceRef alone); only a
 * non-array `entryIds` is rejected. Secret screening happens again inside `enqueue` (defense in
 * depth); redaction of user content is the command layer's responsibility
 * and is exercised there — this builder never persists anything itself.
 */
export function buildExplicitPersonalEnqueue(
  input: ExplicitPersonalInput,
): EnqueueInput {
  const statement = input.statement.trim();
  if (statement === "") {
    throw new ExplicitPersonalInputError(
      "explicit personal record refused: empty statement",
    );
  }
  if (statement.length > PERSONAL_STATEMENT_MAX_CHARS) {
    throw new ExplicitPersonalInputError(
      `explicit personal record refused: statement exceeds ${PERSONAL_STATEMENT_MAX_CHARS} chars`,
    );
  }
  // Inert-data guard, mirroring the extractor and the sender's re-check.
  if (statement.includes(DATA_FENCE_END) || statement.includes("-->")) {
    throw new ExplicitPersonalInputError(
      "explicit personal record refused: statement contains a reserved serialization marker",
    );
  }
  const entryIds = input.entryIds ?? [];
  if (
    !Array.isArray(entryIds) ||
    !entryIds.every((e) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(e))
  ) {
    throw new ExplicitPersonalInputError(
      "explicit personal record refused: entryIds must be an array of strict ids",
    );
  }
  if (typeof input.sessionId !== "string" || input.sessionId === "") {
    throw new ExplicitPersonalInputError(
      "explicit personal record refused: sessionId missing",
    );
  }
  const opId = input.opId ?? randomUUID();
  const sources = [
    {
      sessionId: input.sessionId,
      ...(input.branchId !== undefined && input.branchId !== ""
        ? { branchId: input.branchId }
        : {}),
      entryIds,
    },
  ];
  const payload: ObservationPayload = {
    opId,
    // Reuses the existing manual trigger; the scope itself marks the record
    // as explicit personal (kind/scope are the routing identity).
    trigger: "manual",
    sessionId: input.sessionId,
    ...(input.branchId !== undefined && input.branchId !== ""
      ? { branchId: input.branchId }
      : {}),
    inputBudgetTokens: 0,
    outputBudgetTokens: 0,
    sourceEntryIds: entryIds,
    observations: [{ sourceEntryIds: entryIds, statement, uncertainty: "low" }],
  };
  return {
    kind: "observation",
    scope: PERSONAL_SCOPE,
    opId,
    idempotencyKey: idempotencyKey({
      kind: "observation",
      scope: PERSONAL_SCOPE,
      sources,
      tokens: ["explicit-personal"],
    }),
    payload,
  };
}
