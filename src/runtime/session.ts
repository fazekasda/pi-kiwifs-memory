/**
 * Q06B1: per-session runtime construction, extracted from src/index.ts.
 *
 * This module OWNS the shipped `SessionRuntime` composition:
 * `buildSessionRuntime` (same function, moved verbatim) constructs every
 * owned resource — durable outbox + production outbox worker (live private-
 * mode gate + durable audit sink), observation scheduler/reflection/proposal
 * lifecycle, retrieval coordinator + tombstone cache, tokenizer attach,
 * backup capture, and board delivery — in the SAME initialization order as
 * before the extraction, with the same fail-closed holds for unconfigured/
 * unresolvable dependencies (dormant resources stay `undefined` until their
 * feature/config resolves; they never throw past session_start).
 *
 * Backend construction reuses the shared factory (`openConfiguredBackend` →
 * `openBearerAdapter`, `buildBearerAdapter`), preserving the Q06A/Q06B0
 * fail-closed bearer semantics: an unresolved credential yields `undefined`
 * and the retryable hold, never an empty token.
 *
 * Command registration and status text remain in src/index.ts (Q06C1: status
 * probe aggregation lives in src/runtime/status.ts, which index pushes the
 * runtime-derived probes into via `wireRuntimeStatusProbes`). This module
 * never imports index or the status module (no cycles): the tokenizer attach
 * note is OWNED by the runtime instance (`rt.tokenizerNote`, mutated after
 * the async load) and the status probe reads the CURRENT runtime, so a
 * superseded session's late note can never surface. Q06C1: the former
 * `setTokenizerNoteSink` hook is deliberately removed — after the session
 * extraction it was exported but registered by nobody (an orphan), and the
 * runtime-owned note plus the current-runtime probe is the single status
 * path.
 */
import { join, dirname } from "node:path";
import { loadConfig } from "../config/loader.ts";
import type { AuthRef } from "../config/schema.ts";
import { effectiveFeatures, type MemoryConfig } from "../config/schema.ts";
import { KiwiFSAdapter } from "../backend/adapter.ts";
import { openBearerAdapter, buildBearerAdapter } from "../backend/factory.ts";
import type { OpIdLedger } from "../backend/opid.ts";
import {
  createModelExtractor,
  resolveAuthSecret,
} from "../observation/model.ts";
import { createObservationSender } from "../observation/sender.ts";
import {
  type AcceptedRecord,
  ReflectionEngine,
  createModelReflector,
} from "../observation/reflection.ts";
import { ProposalLifecycle, ProposalOpLog } from "../observation/proposals.ts";
import { SessionCoordinator } from "../pi/coordinator.ts";
import { BackupCapture } from "../backup/capture.ts";
import { RetrievalCoordinator } from "../retrieval/coordinator.ts";
import { QueryMetaTombstoneCache } from "../backend/guard.ts";
import { BoardRepository } from "../board/repository.ts";
import { BoardDeliveryRuntime } from "../board/runtime.ts";
import { discoverProjectIdentity } from "../scope/discovery.ts";
import { FileAuditStore } from "../privacy/audit-store.ts";
import type { AuditSinkLike } from "../privacy/audit.ts";
import {
  LiveConfigPrivateModeGate,
  readConfigLive,
} from "../privacy/live-gate.ts";
import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  DEFAULT_OUTPUT_BUDGET_TOKENS,
  ObserverScheduler,
} from "../observation/scheduler.ts";
import { DurableOutbox, OutboxError } from "../outbox/store.ts";
import { OutboxWorker } from "../outbox/worker.ts";
import { targetFingerprint } from "../outbox/target.ts";
import type { OutboxJob } from "../outbox/store.ts";
import { loadConfiguredTokenizer } from "../retrieval/tokenizer.ts";
import { validateProjectId } from "../domain/paths.ts";

/**
 * Q06C1 sink-orphan fix: the Q06B2 `setTokenizerNoteSink` hook (and its
 * build-epoch gate) is removed — exported, but registered by nobody after
 * the session extraction. The tokenizer note is owned by the runtime
 * instance below and surfaced through the status probe, which reads the
 * CURRENT runtime; a previous session's late attach/degrade note mutates
 * only ITS OWN (superseded) runtime and cannot leak into status.
 */

/**
 * Local durable state directory for the session coordinator (generation
 * counter, consumed-entry registry). Provisional location convention:
 * `KIWIFS_MEMORY_STATE_DIR` wins, otherwise project-local `<cwd>/.kiwifs/memory/`.
 * The final discovery convention is a documented T18 UX follow-up.
 */
export function resolveStateDir(cwd: string): string {
  const env = process.env["KIWIFS_MEMORY_STATE_DIR"];
  if (env && env.trim() !== "") return env;
  return join(cwd, ".kiwifs", "memory");
}

/**
 * Record scope for observation storage (T10, discovery closed in T18).
 * Precedence: explicit `projectIdentity` override wins; otherwise the
 * project identity is discovered at runtime from `git remote -v` in `cwd`
 * (host[/owner]/repo, fail closed on zero/conflicting/unparseable remotes —
 * exactly the T03 policy, now actually consumed). An unresolved scope is
 * NOT a writable owner scope: observation/backup stay held with a visible
 * reason rather than minting jobs that could only be quarantined.
 */
export function resolveRecordScope(
  config: MemoryConfig,
  cwd: string,
):
  | { ok: true; scope: string; source: "override" | "git-remote" }
  | { ok: false; reason: string } {
  if (config.projectIdentity) {
    return {
      ok: true,
      scope: `project/${config.projectIdentity.toLowerCase()}`,
      source: "override",
    };
  }
  const discovered = discoverProjectIdentity({ cwd });
  if (!discovered.ok) {
    return {
      ok: false,
      reason: `record scope not resolved: ${discovered.detail}`,
    };
  }
  return {
    ok: true,
    scope: `project/${discovered.projectId}`,
    source: discovered.source,
  };
}

/**
 * Builds the observation-delivery backend from the validated config.
 * Returns undefined when MCP is not configured or the credential reference
 * does not resolve — the sender then reports a retryable availability gap
 * and jobs stay pending (never dropped, never quarantined).
 *
 * The MCP transport authenticates exclusively via `AdapterOptions.headers`
 * (src/backend/transport.ts), so the `mcp.auth` reference is resolved to a
 * bearer Authorization header — same wiring as the live runner. The secret
 * value is resolved per delivery attempt by reference and is never logged,
 * echoed or stored. Q06A: construction is delegated to the shared factory
 * (`openBearerAdapter`), which preserves this exact fail-closed behavior.
 */
export function openConfiguredBackend(
  config: MemoryConfig,
  ledger: OpIdLedger,
): KiwiFSAdapter | undefined {
  if (!config.enabled || config.mcp.url === "" || !config.mcp.auth) {
    return undefined;
  }
  return openBearerAdapter(config.mcp.url, config.mcp.auth, ledger);
}

/** Per-session runtime built lazily at session_start. */
export interface SessionRuntime {
  coordinator: SessionCoordinator;
  observer: ObserverScheduler | undefined;
  reflection: ReflectionEngine | undefined;
  lifecycle: ProposalLifecycle | undefined;
  retrieval: RetrievalCoordinator | undefined;
  retrievalHeldReason: string | undefined;
  observerError: string | undefined;
  store: DurableOutbox | undefined;
  /** Q02a: the production outbox worker (exposed for status/tests; the tick driver is the coordinator). */
  worker: OutboxWorker | undefined;
  /**
   * Q02c: the shared production live-config gate (same instance the outbox
   * worker holds). Exposes the transition-notification subscription the
   * command bridge pushes into after a persisted private-mode flip, and is
   * disposed at session shutdown so subscriptions are released.
   */
  liveGate: LiveConfigPrivateModeGate | undefined;
  /** T13: advisory tombstone cache over the retrieval backend (may be undefined). */
  tombstoneCache: QueryMetaTombstoneCache | undefined;
  /** T13: tokenizer attach/load note (sanitized, status-only). */
  tokenizerNote: string | undefined;
  /** Structured degradation flag for the tokenizer note (T18 review fix). */
  tokenizerDegraded: boolean;
  /** T14: incremental transcript backup capture (may be undefined). */
  backup: BackupCapture | undefined;
  backupHeldReason: string | undefined;
  /** T17: bounded board delivery + local ack state (may be undefined). */
  delivery: BoardDeliveryRuntime | undefined;
  deliveryHeldReason: string | undefined;
  /** Q04b: the production durable audit sink (exposed for status/tests). */
  audit: FileAuditStore;
}

/**
 * T09: builds the session runtime — coordinator (with real outbox tick and
 * retention callbacks, closing the T08 dormant-timer follow-up), durable
 * outbox + worker, and the observation scheduler. Outbox/observer construction
 * failures disable those pieces visibly instead of breaking Pi startup.
 */
export function buildSessionRuntime(cwd: string): SessionRuntime {
  // Q06B2: this build owns its runtime instance; async continuations (the
  // tokenizer module load) mutate THIS instance's fields only, so a stale
  // session's note can never overwrite a newer session's status.
  const stateDir = resolveStateDir(cwd);
  const configResult = loadConfig();
  const config = configResult.ok ? configResult.config : undefined;
  let store: DurableOutbox | undefined;
  let observerError: string | undefined;
  try {
    store = DurableOutbox.open(join(stateDir, "outbox"), {
      // Q07C: pin each job's delivery target at enqueue time from the
      // session snapshot (endpoint + auth-ref identity + record scope).
      ...(config
        ? {
            targetFor: (jobScope: string) =>
              targetFingerprint(config.mcp.url, config.mcp.auth, jobScope),
          }
        : {}),
    });
  } catch (err) {
    observerError =
      err instanceof OutboxError
        ? err.message
        : `outbox init failed: ${(err as Error).name}`;
  }
  // T10 + T18: real observation sender. When MCP is unconfigured, the
  // credential does not resolve, or the record scope is not resolved
  // (no override and git-remote discovery failed closed), the sender throws
  // the retryable SenderNotWiredError (jobs stay pending with backoff —
  // never dropped, never quarantined).
  const scopeResolution = config ? resolveRecordScope(config, cwd) : undefined;
  const scope = scopeResolution?.ok ? scopeResolution.scope : undefined;
  if (scopeResolution && !scopeResolution.ok)
    observerError = scopeResolution.reason;
  // Q07C: the session SNAPSHOT's delivery-target identity. Jobs enqueued in
  // this session pin the enqueue-time fingerprint (endpoint URL + auth-ref
  // identity + record scope, sha-256 — src/outbox/target.ts); delivery time
  // re-derives the expected fingerprint from THIS session's snapshot. A
  // changed endpoint / credential-reference identity / record scope across a
  // session rebuild therefore HELDS retained jobs (worker pre-send check):
  // endpoint/credential/scope changes can never reroute persisted jobs.
  // Credential VALUE rotation behind the same reference keeps the
  // fingerprint (only ref identity enters the hash) — delivery proceeds.
  // Personal jobs always deliver at their own `personal` scope (Q05P1),
  // which is the sender's routing too — so the expected fingerprint uses the
  // job's own scope for personal, the session scope otherwise (mirrors the
  // sender's delivery-scope resolution below).
  const expectedTarget = config
    ? (job: OutboxJob) =>
        targetFingerprint(
          config.mcp.url,
          config.mcp.auth,
          job.scope === "personal" ? "personal" : (scope ?? job.scope),
        )
    : undefined;
  // Q02a: production privacy dependency for the outbox worker — a fail-closed
  // live-config gate (re-read per check, same semantics as retrieval/backup/
  // board) and a sanitized metadata-only audit sink. NOT test-only assembly:
  // this is the shipped construction, so private-mode flips persisted via
  // setPrivateModeInFile hold NEW sends/retries at the next tick and resume
  // releases preexisting pending work (never dropped, never duplicated).
  const outboxGate = new LiveConfigPrivateModeGate();
  // Q04b: durable bounded audit sink in PRODUCTION composition. The store is
  // instantiated in the shipped runtime (never test-only assembly): JSONL
  // under the state dir, bounded rotation (256 KiB x 3 files), private
  // permissions, single-owner lock, never-throwing record. Q04a defaults are
  // the approved proposal values; no config surface is parsed here.
  const auditStore = new FileAuditStore({ path: join(stateDir, "audit.log") });
  const outboxAudit: AuditSinkLike = auditStore;
  const worker = store
    ? new OutboxWorker({
        store,
        send: createObservationSender({
          scope,
          openBackend: async () => {
            if (!config) return undefined;
            const backend = openConfiguredBackend(config, store.ledger());
            if (backend) await backend.connect();
            return backend;
          },
        }),
        gate: outboxGate,
        audit: outboxAudit,
        // Availability gaps (backend unconfigured/outage) retry without an
        // attempt cap; permanent failures (validation/conflict) quarantine
        // per the worker's own rules.
        maxAttempts: Number.MAX_SAFE_INTEGER,
        // Q07C: target pin — see expectedTarget above. Undefined when the
        // snapshot has no config (jobs then deliver as legacy-shaped).
        ...(expectedTarget ? { expectedTarget } : {}),
      })
    : undefined;
  const coordinator = new SessionCoordinator({
    stateDir,
    ...(worker ? { onTick: () => void worker.tick() } : {}),
    ...(store ? { onRetention: () => store.runRetention() } : {}),
  });
  let observer: ObserverScheduler | undefined;
  let reflection: ReflectionEngine | undefined;
  let lifecycle: ProposalLifecycle | undefined;
  if (store) {
    try {
      const features = config ? effectiveFeatures(config) : undefined;
      // No resolved scope yet → hold observation entirely (T18 discovery):
      // extraction would only mint jobs the sender can never deliver.
      const extract =
        config !== undefined &&
        features !== undefined &&
        features.observation &&
        config.enabled &&
        config.model.auth &&
        scope !== undefined
          ? createModelExtractor({
              route: config.model.route,
              auth: config.model.auth,
              inputBudgetTokens: DEFAULT_INPUT_BUDGET_TOKENS,
              outputBudgetTokens: DEFAULT_OUTPUT_BUDGET_TOKENS,
              // Q02: the shared production gate guards every model attempt
              // (pull re-read + transition-time cancel for in-flight work).
              gate: outboxGate,
            })
          : undefined;
      // No resolved scope → no observer at all: nothing can be extracted
      // into a deliverable record, so scheduling is held (T18 discovery).
      if (scope !== undefined) {
        // T11: reflection engine over durably accepted observation records.
        // Automatic summaries ride the observation feature (decisions.md
        // #11); proposals/conflict flags are always approval-gated.
        if (config && features?.observation && config.enabled) {
          const reflect = config.model.auth
            ? createModelReflector({
                route: config.model.route,
                auth: config.model.auth,
                // Q02: same shared gate at the reflection model boundary.
                gate: outboxGate,
              })
            : undefined;
          reflection = new ReflectionEngine({
            stateDir,
            scope,
            outbox: store,
            ...(reflect ? { reflect } : {}),
            // Q04c: same production sink — reflection run/skip events.
            audit: outboxAudit,
          });
          // Proposal lifecycle: own durable op log (opIds recorded BEFORE
          // any side effect) and its own backend instance — the lifecycle
          // mints interactive opIds the outbox ledger does not know.
          if (config.mcp.url !== "" && config.mcp.auth) {
            const opLog = new ProposalOpLog(stateDir);
            const mcpAuth: AuthRef = config.mcp.auth;
            const mcpUrl = config.mcp.url;
            lifecycle = new ProposalLifecycle({
              opLog,
              // Q04c: change events (approve/reject/undo) ride the same
              // production sink.
              audit: outboxAudit,
              openStore: (() => {
                let cached: KiwiFSAdapter | undefined;
                return async () => {
                  if (!cached) {
                    // Shared factory: fail-closed bearer construction —
                    // unresolvable credential → undefined (retryable hold;
                    // cached stays unset so the next call re-resolves). The
                    // inline ledger object is the lifecycle's OWN opId
                    // policy (opIds durably persisted in the proposal op
                    // log BEFORE any side effect), not adapter wiring.
                    cached = openBearerAdapter(mcpUrl, mcpAuth, {
                      record: (opId: string) => {
                        if (!opLog.has(opId)) {
                          throw new Error(
                            "refusing to record opId that is not durably persisted",
                          );
                        }
                      },
                      assertPersisted: (opId: string) => {
                        if (!opLog.has(opId)) {
                          throw new Error(
                            "opId was not durably persisted before mutation (refusing side effect)",
                          );
                        }
                      },
                    });
                    if (!cached) return undefined;
                    await cached.connect();
                  }
                  return cached;
                };
              })(),
            });
          }
        }
        observer = new ObserverScheduler({
          stateDir,
          coordinator,
          outbox: store,
          scope,
          sessionId: "pending",
          ...(extract ? { extract } : {}),
          // Q02: live private-mode check at every scheduler boundary
          // (settled/idle/manual/precompact); fail-closed via the shared gate.
          isPrivate: () => outboxGate.isPrivate,
          ...(reflection
            ? {
                onAcceptedObservations: (info) => {
                  // Feed durably accepted observation records to the
                  // reflection engine (record-granular dedupe inside).
                  const record: AcceptedRecord = {
                    recordId: info.recordId,
                    recordPath: info.recordPath,
                    createdAt: info.createdAt,
                    statements: info.observations.map((o) => o.statement),
                    uncertainty: info.observations.some(
                      (o) => o.uncertainty === "high",
                    )
                      ? "high"
                      : info.observations.some(
                            (o) => o.uncertainty === "medium",
                          )
                        ? "medium"
                        : "low",
                    sourceEntryIds: info.sourceEntryIds,
                    sessionId: info.sessionId,
                    ...(info.branchId !== undefined
                      ? { branchId: info.branchId }
                      : {}),
                  };
                  reflection?.noteAccepted(record);
                  // Automatic bounded reflection at the [P] threshold;
                  // failures are contained and visible via pendingStatus.
                  void reflection?.maybeReflect().then((r) => {
                    if (!r.ran && r.skippedReason === "no-reflector") {
                      observerError =
                        "reflection: model.auth not configured — automatic summaries held (observations intact)";
                    }
                  });
                },
              }
            : {}),
        });
      }
    } catch (err) {
      observerError = `observer init failed: ${(err as Error).name}`;
    }
  }
  // T12 + T13: per-user-input RAG retrieval and its recall surface. The
  // authorized scope set is the resolved project scope plus personal
  // (config) plus the explicitly opted-in cross-project scopes
  // (scopes.crossProjectOptIn — per-session opt-in declarators wired to
  // their owner scopes; empty list = denied by default, decisions.md #5).
  // Retrieval requires a configured, credential-resolvable backend; without
  // one it is held visibly, never silently skipped.
  let retrieval: RetrievalCoordinator | undefined;
  let retrievalHeldReason: string | undefined;
  let tombstoneCache: QueryMetaTombstoneCache | undefined;
  if (
    store &&
    config &&
    config.enabled &&
    config.mcp.url !== "" &&
    config.mcp.auth
  ) {
    const retrievalScopes: string[] = [];
    if (scope !== undefined) retrievalScopes.push(scope);
    if (config.scopes.allowPersonalGlobal) retrievalScopes.push("personal");
    const cross = crossOptInToScopes(config.scopes.crossProjectOptIn);
    if (cross.invalid.length > 0) {
      retrievalHeldReason =
        "cross-project opt-in contains invalid project id(s) — those entries authorize nothing";
    }
    retrievalScopes.push(...cross.scopes);
    if (retrievalScopes.length === 0) {
      retrievalHeldReason =
        retrievalHeldReason ??
        "no authorized scope resolves (projectIdentity unset and personal scope disabled)";
    } else if (!resolveAuthSecret(config.mcp.auth)) {
      retrievalHeldReason =
        "backend credential reference does not resolve (retryable hold)";
    } else {
      const mcpAuth: AuthRef = config.mcp.auth;
      const mcpUrl = config.mcp.url;
      // Q06B0: the factory itself fails closed — an unresolved credential at
      // construction time (TOCTOU vs. the hold check above) yields undefined
      // and the same retryable hold, never an empty bearer token.
      const adapter = buildBearerAdapter(mcpUrl, mcpAuth, store.ledger());
      if (adapter === undefined) {
        retrievalHeldReason =
          "backend credential reference does not resolve (retryable hold)";
      } else {
        retrieval = new RetrievalCoordinator({
          adapter,
          authorizedScopes: retrievalScopes,
          // Q04c: sanitized retrieval outcome events (holds/degradations).
          audit: outboxAudit,
          deadlineMs: config.budgets.ragDeadlineMs,
          tokenCap: config.budgets.evidenceTokenCap,
          generation: coordinator.generation,
          // Live gate: re-read per cycle via the single config owner
          // (readConfigLive — Q07B1); an INVALID config fails closed to
          // private (zero reads). A stale snapshot would let a user's
          // private-mode flip leave retrieval running (T18 requirement).
          privateMode: () => readConfigLive().privateMode,
        });
        // T13: advisory tombstone cache for the recall tools (§13 row 7 —
        // TTL 5 min inside the cache; a stale/missing cache never permits a
        // forgotten record through: the read-back is the gate).
        tombstoneCache = new QueryMetaTombstoneCache(
          adapter,
          retrieval.scopeSet(),
        );
      }
    }
  }
  // T13: user-configured tokenizer (§13 row 5). The module loads
  // asynchronously; until it attaches, inputs visibly skip automatic
  // injection (TOKENIZER_UNAVAILABLE_NOTE via the coordinator). A failed
  // load never becomes a character-estimate fallback: injection stays
  // skipped and the reason is visible. Q06B2: the note is OWNED by this
  // runtime instance (mutated on `rt` after return) — a previous session's
  // late attach/degrade note never reaches the status probe, which reads
  // the CURRENT runtime.
  let tokenizerNote: string | undefined;
  let tokenizerDegraded = false;
  // T14: incremental transcript backup capture (features.backup). Requires
  // a resolved project scope (the `backup/{project-id}/` namespace needs a
  // project id); like the observer, capture is held until scope resolution
  // (T18 git-remote discovery) rather than queuing undeliverable jobs.
  // Private mode is re-checked inside every capture (no new backup jobs).
  let backup: BackupCapture | undefined;
  let backupHeldReason: string | undefined;
  if (store && config && config.enabled && scope?.startsWith("project/")) {
    const features = effectiveFeatures(config);
    if (features.backup) {
      try {
        backup = new BackupCapture({
          stateDir,
          outbox: store,
          scope,
          projectId: scope.slice("project/".length),
          sessionId: coordinator.sessionId ?? "pending",
          ...(coordinator.branchId ? { branchId: coordinator.branchId } : {}),
          // Live gate (single owner, Q07B1): re-read per capture; invalid
          // config fails closed (no new backup jobs).
          privateMode: () => readConfigLive().privateMode,
          exclusions: config.privacy.exclusions,
          // Q04c: sanitized backup capture/hold events.
          audit: outboxAudit,
        });
      } catch (err) {
        backupHeldReason = `backup init failed: ${(err as Error).message}`;
      }
    }
  }
  // T17: bounded board delivery + local acknowledgment state. Requires the
  // board feature, a configured/resolvable backend and a STABLE consumer id
  // (board.consumerId) — per-consumer cursors must outlive a session, so
  // there is no safe default; without it delivery is HELD VISIBLY. The
  // private-mode gate is re-evaluated per cycle (fail closed: invalid config
  // → zero reads) and stop() is wired to every generation-changing lifecycle
  // event below.
  let delivery: BoardDeliveryRuntime | undefined;
  let deliveryHeldReason: string | undefined;
  if (store && config && config.enabled && config.mcp.url !== "") {
    const features17 = effectiveFeatures(config);
    if (features17.board) {
      if (!config.mcp.auth) {
        // Visible hold (T17 review fix): the backend can never be reached,
        // so delivery must not look silently "idle/empty" — and the inbox
        // tool's refusal must point at the real cause, not at consumerId.
        deliveryHeldReason =
          "mcp.auth not configured — no backend reads; configure the credential to enable board delivery";
      } else if (!resolveAuthSecret(config.mcp.auth)) {
        deliveryHeldReason =
          "backend credential reference does not resolve (retryable hold)";
      } else if (!config.board?.consumerId) {
        deliveryHeldReason =
          "board.consumerId not configured — per-consumer delivery state requires a stable id; send/list/read remain available";
      } else {
        try {
          const mcpAuth: AuthRef = config.mcp.auth;
          const mcpUrl = config.mcp.url;
          // Live gates via the single config owner (Q07B1): re-read config
          // per cycle/call; an INVALID config fails closed to private (zero
          // reads, zero writes).
          const liveGate = () => readConfigLive().privateMode;
          const repoGate = {
            get isPrivate() {
              return liveGate();
            },
          };
          const boardAdapter = buildBearerAdapter(
            mcpUrl,
            mcpAuth,
            store.ledger(),
          );
          if (boardAdapter === undefined) {
            deliveryHeldReason =
              "backend credential reference does not resolve (retryable hold)";
          } else {
            const boardRepo = new BoardRepository(boardAdapter, {
              privateMode: repoGate,
            });
            delivery = new BoardDeliveryRuntime({
              stateDir: join(stateDir, "board"),
              consumerId: config.board.consumerId,
              ...(config.board.recipient !== undefined
                ? { recipient: config.board.recipient }
                : {}),
              // T18: user-configurable delivery cadence/bounds (validated,
              // bounded in the schema — out-of-range values fail validation,
              // never clamp).
              ...(config.board.pollMs !== undefined
                ? { pollMs: config.board.pollMs }
                : {}),
              ...(config.board.backoffMs !== undefined
                ? { backoffMs: config.board.backoffMs }
                : {}),
              ...(config.board.backlogPauseAt !== undefined
                ? { backlogPauseAt: config.board.backlogPauseAt }
                : {}),
              repo: boardRepo,
              isPrivate: liveGate,
            });
          }
        } catch (err) {
          deliveryHeldReason = `board delivery init failed: ${(err as Error).message}`;
        }
      }
    }
  }
  // Q06B2: the runtime object is assembled first so async continuations
  // (the tokenizer attach below) mutate THIS instance's fields — the note
  // is owned by the runtime, not a closure snapshot. A previous session's
  // late attach/degrade note therefore mutates only the superseded runtime;
  // the status probe reads the CURRENT runtime and never sees it.
  const rt: SessionRuntime = {
    coordinator,
    observer,
    reflection,
    lifecycle,
    retrieval,
    retrievalHeldReason,
    observerError,
    store,
    worker,
    liveGate: outboxGate,
    tombstoneCache,
    tokenizerNote,
    tokenizerDegraded,
    backup,
    backupHeldReason,
    delivery,
    deliveryHeldReason,
    audit: auditStore,
  };
  if (retrieval && config?.budgets.tokenizer) {
    const spec = config.budgets.tokenizer;
    const baseDir =
      configResult.ok && configResult.file ? dirname(configResult.file) : cwd;
    void loadConfiguredTokenizer(spec, baseDir).then((result) => {
      if (result.ok) {
        retrieval?.setTokenizer(result.tokenizer);
        rt.tokenizerNote = `model-compatible tokenizer attached (${result.tokenizer.id})`;
        rt.tokenizerDegraded = false;
      } else {
        rt.tokenizerNote = `automatic injection stays skipped — ${result.reason}`;
        rt.tokenizerDegraded = true; // structured flag, not keyword matching
      }
    });
  }
  return rt;
}

/**
 * T13: map configured cross-project opt-in values (`cross/{project-id}`) to
 * authorized scope values (`project/{project-id}`). Record scope is a single
 * owner value (§2) — records never carry a `cross/...` scope — so the opt-in
 * DECLARATOR authorizes the target project's owner scope for this session's
 * retrieval and recall tools. Entries failing the project-id grammar are
 * reported (never silently ignored); they authorize nothing.
 */
export function crossOptInToScopes(values: readonly string[]): {
  scopes: string[];
  invalid: string[];
} {
  const scopes: string[] = [];
  const invalid: string[] = [];
  for (const v of values) {
    const id = v.slice("cross/".length);
    try {
      const normalized = validateProjectId(id);
      scopes.push(`project/${normalized}`);
    } catch {
      invalid.push(v);
    }
  }
  return { scopes, invalid };
}
