/**
 * Q06A: single construction boundary for the observation backend
 * (behavior-preserving extraction of the duplicated
 * `resolveAuthSecret` → `Authorization: Bearer` → `KiwiFSAdapter` wiring
 * that lived in src/index.ts and src/commands/manual-ops.ts).
 *
 * Two call-site shapes exist upstream and BOTH are preserved exactly:
 *
 * - `openBearerAdapter` resolves the credential reference itself and
 *   returns `undefined` when the secret does not resolve (fail-closed
 *   hold). Callers treat `undefined` as "backend not wired": the sender
 *   reports a retryable availability gap and durable jobs stay pending
 *   (never dropped, never quarantined, never sent unauthenticated).
 *
 * - `buildBearerAdapter` is for call sites that must distinguish hold
 *   reasons for status text (retrieval, board delivery): the caller checks
 *   `resolveAuthSecret` first to produce its own visible hold reason, then
 *   constructs. The caller's guard is advisory only — the factory itself
 *   re-resolves and returns `undefined` (fail-closed hold) when the
 *   credential unresolves at construction time, so no request can ever be
 *   started with an empty bearer token (Q06B0: the previous `?? ""`
 *   fallback could send `Authorization: Bearer` unauthenticated if the
 *   caller's check raced an env/file credential change).
 *
 * The op-id ledger is a REQUIRED, typed parameter at this boundary — there
 * is no default ledger, because mutations must refuse to run without a
 * durably persisted opId (T04). Callers pass their own durable ledger
 * (outbox op log, proposal op log, manual op log, board-cleanup op log).
 *
 * Construction performs no network I/O; `connect()` remains the only I/O
 * entry point (adapter.ts guarantee). The resolved secret value exists only
 * inside the Authorization header and is never logged or echoed. Omitting
 * `extra` keeps the transport's own defaults (10 s per-request timeout,
 * 48 MiB response bound) — the factory introduces no implicit limits.
 */

import type { AuthRef } from "../config/schema.ts";
import { resolveAuthSecret } from "../observation/model.ts";
import { KiwiFSAdapter, type AdapterOptions } from "./adapter.ts";
import type { OpIdLedger } from "./opid.ts";

/**
 * Credential-reference resolution at the shared boundary. A pure named
 * re-export of `resolveAuthSecret` (env or file; fail-closed; the resolved
 * value is never logged) so construction and resolution live in one module.
 */
export { resolveAuthSecret as resolveBearerSecret };

/** Optional transport tuning; url/headers/ledger are factory-controlled. */
export type BearerAdapterExtra = Pick<
  AdapterOptions,
  "requestTimeoutMs" | "maxResponseBytes" | "fetchImpl"
>;

/**
 * Site shape used by the observation sender (`openConfiguredBackend`), the
 * proposal lifecycle and manual ops: resolve the credential, return
 * `undefined` when it does not resolve (retryable hold), otherwise build
 * the bearer adapter with the caller's ledger threaded unchanged.
 */
export function openBearerAdapter(
  url: string,
  auth: AuthRef,
  ledger: OpIdLedger,
  extra?: BearerAdapterExtra,
): KiwiFSAdapter | undefined {
  const secret = resolveAuthSecret(auth);
  if (secret === undefined) {
    return undefined; // fail closed: unresolvable credential → retryable hold
  }
  return new KiwiFSAdapter({
    url,
    headers: { Authorization: `Bearer ${secret}` },
    ledger,
    ...(extra !== undefined ? extra : {}),
  });
}

/**
 * Site shape used by retrieval and board delivery, where the caller has
 * already checked the credential to produce its own hold reason. The caller's
 * guard is advisory only: the factory re-resolves and returns `undefined`
 * (fail-closed hold) when the credential unresolves, so no request can be
 * started with an empty bearer token (Q06B0).
 */
export function buildBearerAdapter(
  url: string,
  auth: AuthRef,
  ledger: OpIdLedger,
): KiwiFSAdapter | undefined {
  const secret = resolveAuthSecret(auth);
  if (secret === undefined) {
    return undefined; // fail closed: absent/empty credential → no unauthenticated requests
  }
  return new KiwiFSAdapter({
    url,
    headers: { Authorization: `Bearer ${secret}` },
    ledger,
  });
}
