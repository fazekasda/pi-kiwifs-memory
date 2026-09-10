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
 *   constructs. The header's `?? ""` fallback is preserved verbatim so the
 *   guard contract stays identical even if a caller's check raced.
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
 * already checked the credential to produce its own hold reason. Builds the
 * adapter unconditionally; the `?? ""` fallback below is preserved verbatim
 * from the pre-extraction call sites (guard parity — do not "tighten" it
 * into a throw without changing the callers' hold semantics).
 */
export function buildBearerAdapter(
  url: string,
  auth: AuthRef,
  ledger: OpIdLedger,
): KiwiFSAdapter {
  return new KiwiFSAdapter({
    url,
    headers: { Authorization: `Bearer ${resolveAuthSecret(auth) ?? ""}` },
    ledger,
  });
}
