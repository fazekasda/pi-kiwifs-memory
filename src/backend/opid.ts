/**
 * T04: operation-id ledger (architecture.md §2).
 *
 * Every mutating operation carries a durable, randomly unique `opId` that the
 * caller persists (outbox job, T07) BEFORE any side effect. The adapter
 * refuses to mutate when the opId was not recorded as persisted: re-derivation
 * after a crash must reuse the persisted identity, never mint a second one.
 */

import { randomUUID } from "node:crypto";
import { OpIdNotPersistedError } from "./errors.ts";

export interface OpIdLedger {
  /** Record an opId as durably persisted (called by the outbox layer). */
  record(opId: string): void;
  /** Fail closed when the opId was never recorded as persisted. */
  assertPersisted(opId: string): void;
}

export function mintOpId(): string {
  return randomUUID();
}

/** In-memory ledger for tests and non-durable callers; T07 wires a durable one. */
export function createMemoryLedger(): OpIdLedger {
  const persisted = new Set<string>();
  return {
    record(opId: string): void {
      persisted.add(opId);
    },
    assertPersisted(opId: string): void {
      if (!persisted.has(opId)) {
        throw new OpIdNotPersistedError(
          `opId was not durably persisted before mutation (refusing side effect)`,
        );
      }
    },
  };
}
