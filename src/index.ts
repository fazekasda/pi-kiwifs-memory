import { join, dirname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import type { AuthRef } from "./config/schema.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";
import { effectiveFeatures, type MemoryConfig } from "./config/schema.ts";
import { KiwiFSAdapter } from "./backend/adapter.ts";
import { openBearerAdapter, buildBearerAdapter } from "./backend/factory.ts";
import type { OpIdLedger } from "./backend/opid.ts";
import {
  createModelExtractor,
  resolveAuthSecret,
} from "./observation/model.ts";
import { createObservationSender } from "./observation/sender.ts";
import {
  DEFAULT_REFLECT_MIN_OBSERVATIONS,
  type AcceptedRecord,
  ReflectionEngine,
  createModelReflector,
} from "./observation/reflection.ts";
import { ProposalLifecycle, ProposalOpLog } from "./observation/proposals.ts";
import { SessionCoordinator, StateSchemaError } from "./pi/coordinator.ts";
import { BackupCapture } from "./backup/capture.ts";
import { exportBackup, ExportRefusedError } from "./backup/verify.ts";
import { verifyRemoteBackup } from "./backup/recovery.ts";
import { RetrievalCoordinator } from "./retrieval/coordinator.ts";
import { EvidenceInjector } from "./inject/injector.ts";
import {
  buildMemoryReadTool,
  buildMemorySearchTool,
  type RecallRuntime,
  type RecallToolsDeps,
} from "./inject/tools.ts";
import { BoardRepository } from "./board/repository.ts";
import {
  buildBoardReadTool,
  buildBoardListTool,
  buildBoardSendTool,
  buildBoardInboxTool,
  buildBoardAckTool,
  type BoardRuntime,
  type BoardToolsDeps,
} from "./board/tools.ts";
import { BoardDeliveryRuntime } from "./board/runtime.ts";
import { discoverProjectIdentity } from "./scope/discovery.ts";
import {
  setPrivateModeInFile,
  type RuntimeControlSurface,
} from "./runtime/controls.ts";
import { createRedactor, redactText } from "./privacy/redaction.ts";
import {
  ExplicitPersonalInputError,
  buildExplicitPersonalEnqueue,
} from "./commands/personal-note.ts";
import { QueryMetaTombstoneCache } from "./backend/guard.ts";
import { loadConfiguredTokenizer } from "./retrieval/tokenizer.ts";
import { validateId, validateProjectId } from "./domain/paths.ts";
import { PathEscapeError } from "./domain/paths.ts";
import { planBoardCleanup } from "./board/cleanup.ts";
import { executeBoardCleanup } from "./board/cleanup-execute.ts";
import {
  BoardCleanupOpLog,
  cleanupPreviewToken,
  formatCleanupExecution,
  formatCleanupPreview,
  readDurableAckState,
  writePreviewRecord,
} from "./commands/board-cleanup.ts";
import { DurableOutbox, OutboxError } from "./outbox/store.ts";
import { OutboxWorker } from "./outbox/worker.ts";
import { FileAuditStore } from "./privacy/audit-store.ts";
import { buildAuditLine } from "./privacy/audit.ts";
import type { AuditSinkLike } from "./privacy/audit.ts";
import { LiveConfigPrivateModeGate } from "./privacy/live-gate.ts";
import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  DEFAULT_OUTPUT_BUDGET_TOKENS,
  ObserverScheduler,
  toSourceViews,
} from "./observation/scheduler.ts";
import { StaleProposalError } from "./observation/proposals.ts";
import {
  ManualOpLog,
  createManualOps,
  erasureReportLines,
  errorName,
  forgetMemoryPath,
  unforgetMemoryPath,
} from "./commands/manual-ops.ts";

export const STATUS_MESSAGE = "KiwiFS memory extension loaded.";

/** Last coordinator/observer init error, surfaced via status (fail-visible). */
let lastCoordinatorError: (() => string | undefined) | undefined;
let lastObserverError: (() => string | undefined) | undefined;
/** Last retrieval degradation note, surfaced via status (fail-visible, T12). */
let lastRetrievalNote: (() => string | undefined) | undefined;
/** Last tokenizer load/attach note, surfaced via status (fail-visible, T13). */
let lastTokenizerNote: (() => string | undefined) | undefined;
/** Structured tokenizer degradation flag (T18 review fix: no keyword match). */
let lastTokenizerDegraded: (() => boolean) | undefined;
/** Structured outbox capture-paused flag (T18 review fix: coverage gap = degraded). */
let lastCapturePaused: (() => boolean) | undefined;
/** Last backup capture error/note, surfaced via status (fail-visible, T14). */
let lastBackupNote: (() => string | undefined) | undefined;
/** Last board delivery note/status, surfaced via status (fail-visible, T17). */
let lastBoardNote: (() => string | undefined) | undefined;
/** Outbox queue summary, surfaced via status (fail-visible, T18). */
let lastQueueNote: (() => string | undefined) | undefined;
/** Quarantined-job count probe for the overall state line (T18). */
let lastQueueQuarantined: (() => number) | undefined;
/** Q04b: sanitized audit-sink health note, surfaced via status (fail-visible). */
let lastAuditNote: (() => string | undefined) | undefined;

/** Test/inspection hook for the coordinator error probe. */
export function setCoordinatorErrorProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastCoordinatorError = probe;
}

/** Test/inspection hook for the observer error probe. */
export function setObserverErrorProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastObserverError = probe;
}

/** Test/inspection hook for the retrieval note probe (T12). */
export function setRetrievalNoteProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastRetrievalNote = probe;
}

/** Test/inspection hook for the tokenizer note probe (T13). */
export function setTokenizerNoteProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastTokenizerNote = probe;
}

/** Test/inspection hook for the structured tokenizer degradation flag (T18). */
export function setTokenizerDegradedProbe(
  probe: (() => boolean) | undefined,
): void {
  lastTokenizerDegraded = probe;
}

/** Test/inspection hook for the structured capture-paused flag (T18). */
export function setCapturePausedProbe(
  probe: (() => boolean) | undefined,
): void {
  lastCapturePaused = probe;
}

/** Test/inspection hook for the backup note probe (T14). */
export function setBackupNoteProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastBackupNote = probe;
}

/** Test/inspection hook for the board delivery note probe (T17). */
export function setBoardNoteProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastBoardNote = probe;
}

/** Test/inspection hook for the queue summary probe (T18). */
export function setQueueNoteProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastQueueNote = probe;
}

/** Test/inspection hook for the quarantined-count probe (T18). */
export function setQueueQuarantinedProbe(
  probe: (() => number) | undefined,
): void {
  lastQueueQuarantined = probe;
}

function queueQuarantinedCount(): number {
  return lastQueueQuarantined?.() ?? 0;
}

/**
 * T18: overall extension state derived from config + sanitized degradation
 * notes. Precedence: disabled > private > degraded > healthy. Keyword-only
 * retrieval degradation is a degraded note — keyword-only hits are NEVER
 * reported as healthy semantic retrieval.
 */
export function computeOverallState(deps: {
  configOk: boolean;
  enabled: boolean;
  privateMode: boolean;
  /** Sanitized hold/degradation notes (coordinator/observer/retrieval/…). */
  degradedNotes: string[];
  quarantined: number;
}): "disabled" | "private" | "degraded" | "healthy" {
  if (!deps.configOk || !deps.enabled) return "disabled";
  if (deps.privateMode) return "private";
  if (
    deps.quarantined > 0 ||
    deps.degradedNotes.some((n) => n !== undefined && n !== "")
  ) {
    return "degraded";
  }
  return "healthy";
}

/**
 * Resolves the configuration for display. Never throws: configuration
 * problems are visible status output, not crashes (fail-visible, T03).
 */
export function resolveStatusText(): string {
  let text: string;
  const result = loadConfig();
  if (!result.ok) {
    const detail =
      "fatal" in result && result.fatal
        ? result.fatal
        : (result.issues ?? [])
            .map((i) => `${i.path || "(root)"}: ${i.message}`)
            .join("; ");
    return `${STATUS_MESSAGE}\nconfig: INVALID — extension disabled\n${detail}`;
  }
  const lines = resolvedStatusLines(result.config);
  if (!statusIsSecretFree(lines)) {
    // Defensive: never display potentially secret-bearing output.
    return `${STATUS_MESSAGE}\nconfig: loaded (status suppressed — secret-free check failed)`;
  }
  text = `${STATUS_MESSAGE}\n${lines.join("\n")}`;
  // Visible fail-closed surface for lifecycle-state problems (never secrets).
  const coordErr = lastCoordinatorError?.();
  if (coordErr) text += `\nsession coordinator: DISABLED — ${coordErr}`;
  const obsErr = lastObserverError?.();
  // T18 review fix: feature-neutral label — the same unresolved-scope reason
  // may hold observation, backup, or both, and it is shown even when both
  // features are off (visibility), but only degrades when a consumer runs.
  if (obsErr) text += `\nrecords: DISABLED — ${obsErr}`;
  const retrievalNote = lastRetrievalNote?.();
  if (retrievalNote) text += `\nretrieval: degraded — ${retrievalNote}`;
  const tokenizerNote = lastTokenizerNote?.();
  if (tokenizerNote) text += `\ntokenizer: ${tokenizerNote}`;
  const backupNote = lastBackupNote?.();
  if (backupNote) text += `\nbackup: ${backupNote}`;
  const boardNote = lastBoardNote?.();
  if (boardNote) text += `\nboard delivery: ${boardNote}`;
  const auditNote = lastAuditNote?.();
  if (auditNote) text += `\n${auditNote}`;
  const queueNote = lastQueueNote?.();
  if (queueNote) text += `\n${queueNote}`;
  // T18: overall state line — healthy / degraded / disabled / private.
  const features = effectiveFeatures(result.config);
  // Search-capability attribution: any retrieval degradation note (e.g. a
  // hybrid run that fell back to keyword-only) keeps the state DEGRADED;
  // keyword-only results are never presented as healthy semantic search.
  const state = computeOverallState({
    configOk: true,
    enabled: result.config.enabled,
    privateMode: result.config.privateMode,
    degradedNotes: [
      coordErr,
      // T18 review fix: scope/hold errors only degrade when a consuming
      // feature is enabled (misattribution fix — the reason may be real for
      // backup alone; the label is feature-neutral).
      ...(features.observation || features.backup ? [obsErr] : []),
      retrievalNote,
      // T18 review fix: structured flag, never a keyword match on the note.
      lastTokenizerDegraded?.() === true ? tokenizerNote : undefined,
      backupNote,
      boardNote?.startsWith("HELD") ? boardNote : undefined,
      // T18 review fix: a paused capture (coverage gap) is degraded.
      lastCapturePaused?.() === true
        ? "capture paused (coverage gap)"
        : undefined,
      // Q04b: an audit-sink failure degrades the overall state visibly.
      auditNote,
    ].filter((n): n is string => n !== undefined),
    quarantined: result.config.enabled ? queueQuarantinedCount() : 0,
  });
  text = `${text}\nstate: ${state}`;
  if (result.ok && result.config.enabled) {
    if (features.observation && !result.config.model.auth) {
      text +=
        "\nobserver: extraction fails closed — model.auth is not configured (no model calls)";
    }
    if (features.observation && result.config.projectIdentity === undefined) {
      text +=
        "\nobserver: record scope resolves via git-remote discovery (explicit projectIdentity unset)";
    }
    if (
      result.config.enabled &&
      result.config.mcp.url !== "" &&
      result.config.mcp.auth &&
      !resolveAuthSecret(result.config.mcp.auth)
    ) {
      text +=
        "\nbackend: credential reference does not resolve — observation delivery pending (retryable hold)";
    }
  }
  return text;
}

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
function resolveRecordScope(
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
function openConfiguredBackend(
  config: MemoryConfig,
  ledger: OpIdLedger,
): KiwiFSAdapter | undefined {
  if (!config.enabled || config.mcp.url === "" || !config.mcp.auth) {
    return undefined;
  }
  return openBearerAdapter(config.mcp.url, config.mcp.auth, ledger);
}

/** Per-session runtime built lazily at session_start. */
interface SessionRuntime {
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
  const stateDir = resolveStateDir(cwd);
  const configResult = loadConfig();
  const config = configResult.ok ? configResult.config : undefined;
  let store: DurableOutbox | undefined;
  let observerError: string | undefined;
  try {
    store = DurableOutbox.open(join(stateDir, "outbox"));
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
      // The hold check above already proved the credential resolves;
      // buildBearerAdapter preserves the pre-extraction `?? ""` header
      // fallback verbatim (guard parity).
      const adapter = buildBearerAdapter(mcpUrl, mcpAuth, store.ledger());
      retrieval = new RetrievalCoordinator({
        adapter,
        authorizedScopes: retrievalScopes,
        // Q04c: sanitized retrieval outcome events (holds/degradations).
        audit: outboxAudit,
        deadlineMs: config.budgets.ragDeadlineMs,
        tokenCap: config.budgets.evidenceTokenCap,
        generation: coordinator.generation,
        // Live gate: re-read per cycle; an INVALID config fails closed to
        // private (zero reads). A stale snapshot would let a user's
        // private-mode flip leave retrieval running (T18 requirement).
        privateMode: () => {
          const r = loadConfig();
          return !r.ok || r.config.privateMode;
        },
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
  // T13: user-configured tokenizer (§13 row 5). The module loads
  // asynchronously; until it attaches, inputs visibly skip automatic
  // injection (TOKENIZER_UNAVAILABLE_NOTE via the coordinator). A failed
  // load never becomes a character-estimate fallback: injection stays
  // skipped and the reason is visible.
  let tokenizerNote: string | undefined;
  let tokenizerDegraded = false;
  if (retrieval && config?.budgets.tokenizer) {
    const spec = config.budgets.tokenizer;
    const baseDir =
      configResult.ok && configResult.file ? dirname(configResult.file) : cwd;
    void loadConfiguredTokenizer(spec, baseDir).then((result) => {
      if (result.ok) {
        retrieval?.setTokenizer(result.tokenizer);
        tokenizerNote = `model-compatible tokenizer attached (${result.tokenizer.id})`;
        tokenizerDegraded = false;
      } else {
        tokenizerNote = `automatic injection stays skipped — ${result.reason}`;
        tokenizerDegraded = true; // structured flag, not keyword matching
      }
      lastTokenizerNote = () => tokenizerNote;
    });
  }
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
          // Live gate (same rationale as retrieval above): re-read per
          // capture; invalid config fails closed (no new backup jobs).
          privateMode: () => {
            const r = loadConfig();
            return !r.ok || r.config.privateMode;
          },
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
          // Live gates: re-read config per cycle/call; an INVALID config
          // fails closed to private (zero reads, zero writes).
          const liveGate = () => {
            const r = loadConfig();
            return !r.ok || r.config.privateMode;
          };
          const repoGate = {
            get isPrivate() {
              return liveGate();
            },
          };
          const boardRepo = new BoardRepository(
            // Same shape as retrieval above: the hold checks above proved
            // the credential resolves; the `?? ""` fallback lives in the
            // shared factory (guard parity).
            buildBearerAdapter(mcpUrl, mcpAuth, store.ledger()),
            { privateMode: repoGate },
          );
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
        } catch (err) {
          deliveryHeldReason = `board delivery init failed: ${(err as Error).message}`;
        }
      }
    }
  }
  return {
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

/**
 * T18 chunk 1: command-facing runtime control surface. Chunk 2 wires Pi
 * commands to this; the guarantees live in src/runtime/controls.ts. The
 * private-mode flip persists a validated, atomic config edit AND relies on
 * the live gates (retrieval/backup/delivery re-read config per boundary)
 * so an active runtime actually reconfigures — no restart, no stale result:
 * cancelPendingRetrieval additionally bumps the retrieval generation so any
 * evidence pack in flight is dropped at settle instead of surfacing later.
 */
export function buildRuntimeControlSurface(deps: {
  /** Resolved config file path (KIWIFS_MEMORY_CONFIG or explicit); undefined = no writable file. */
  configFile: string | undefined;
  getRetrieval: () => RetrievalCoordinator | undefined;
  getGeneration: () => number;
  /**
   * Q02c: called ONLY after a successful persisted private-mode flip, so the
   * shared live gate can observe the transition immediately (push) instead
   * of waiting for its next pull read — cancel subscribers fire at
   * transition time, not at the next tick. The gate itself decides whether
   * the observed state is a normal→private transition (fail-closed read).
   */
  notifyPrivateTransition?: (value: boolean) => void;
}): RuntimeControlSurface {
  return {
    setPrivateMode: (value) => {
      if (!deps.configFile) {
        return {
          ok: false,
          reason:
            "no config file is in effect (KIWIFS_MEMORY_CONFIG unset) — private mode cannot be persisted; set it in the config source you use",
        };
      }
      const result = setPrivateModeInFile(deps.configFile, value);
      if (result.ok) deps.notifyPrivateTransition?.(value);
      return result;
    },
    cancelPendingRetrieval: () => {
      const r = deps.getRetrieval();
      if (!r) return { ok: false, reason: "retrieval not active" };
      r.setGeneration(deps.getGeneration() + 1);
      return {
        ok: true,
        detail: "in-flight retrieval invalidated (generation bumped)",
      };
    },
  };
}

export interface RuntimeBox {
  /** Lazily-built per-session runtime (undefined until the first session event or explicit build). */
  getRuntime: (cwd: string) => SessionRuntime | undefined;
  /** Sanitized init-failure reason, when runtime construction failed. */
  getRuntimeError: () => string | undefined;
}

/**
 * T08 + T09: session lifecycle and observation hook wiring. Registers Pi
 * lifecycle handlers at the boundaries verified in docs/research/
 * mcp-contracts.md §6 plus the `agent_settled` and `session_before_compact`
 * observation triggers. Handlers are reentrant and never require TUI-only
 * APIs (headless/RPC safe). Runtime construction failures disable features
 * visibly instead of breaking extension startup.
 *
 * T18 chunk 2: returns the runtime box so command handlers share the SAME
 * lazily-built runtime as the event handlers (no duplicate state files, no
 * second outbox owner).
 */
export function registerSessionHandlers(
  pi: ExtensionAPI,
  createRuntime: (cwd: string) => SessionRuntime,
): RuntimeBox {
  let runtime: SessionRuntime | undefined;
  let runtimeError: string | undefined;
  /** Sanitized note for packs dropped unmatched at run settle (T12). */
  let retrievalDropNote: string | undefined;
  lastCoordinatorError = () => runtimeError;
  lastObserverError = () => {
    if (runtimeError) return runtimeError;
    return runtime?.observerError;
  };
  lastRetrievalNote = () => {
    if (runtimeError) return runtimeError;
    if (retrievalDropNote) return retrievalDropNote;
    if (runtime?.retrievalHeldReason) return runtime.retrievalHeldReason;
    return runtime?.retrieval?.lastDegradedNote;
  };
  lastTokenizerNote = () => runtime?.tokenizerNote;
  lastTokenizerDegraded = () => runtime?.tokenizerDegraded ?? false;
  lastBackupNote = () => {
    if (runtime?.backupHeldReason) return runtime.backupHeldReason;
    const lines = runtime?.backup?.pendingStatus() ?? [];
    return lines.length > 0 ? lines.join("; ") : undefined;
  };
  lastBoardNote = () => {
    if (runtime?.deliveryHeldReason) return runtime.deliveryHeldReason;
    const d = runtime?.delivery;
    if (!d) return undefined;
    const s = d.statusSnapshot();
    const err = d.lastErrorFingerprint();
    if (s.holdReason) return `HELD — ${s.holdReason}`;
    return `state=${s.runState} unread=${s.unread} consumer=${s.consumerId}${
      err ? ` lastError=${err}` : ""
    }`;
  };
  // T18: sanitized queue summary for status + overall-state attribution.
  lastQueueNote = () => {
    const s = runtime?.store?.stats;
    if (!s) return undefined;
    return `outbox: pending=${s.pending} quarantined=${s.quarantined}${
      s.paused ? " capture=PAUSED (coverage gap)" : ""
    }`;
  };
  lastQueueQuarantined = () => runtime?.store?.stats.quarantined ?? 0;
  // T18 review fix: capture paused (coverage gap) is a degraded condition.
  lastCapturePaused = () => runtime?.store?.stats.paused ?? false;
  // Q04b: sanitized audit-sink health (content-free: counts + errno class
  // only — never paths, identifiers, or error text). Degraded-only: a healthy
  // sink is silent, like the other status probes.
  lastAuditNote = () => {
    const st = runtime?.audit?.status();
    if (!st || !st.degraded) return undefined;
    const parts = [
      `buffered=${st.buffered}`,
      `writeFailures=${st.writeFailures}`,
    ];
    if (st.lastError) parts.push(`lastError=${st.lastError}`);
    if (st.lock === "unavailable") parts.push("lock=unavailable");
    if (st.corruptSkippedBytes > 0)
      parts.push(`corruptSkippedBytes=${st.corruptSkippedBytes}`);
    return `audit: DEGRADED — ${parts.join(" ")}`;
  };

  const get = (cwd: string): SessionRuntime | undefined => {
    if (runtime) return runtime;
    if (runtimeError) return undefined;
    try {
      runtime = createRuntime(cwd);
    } catch (err) {
      runtimeError =
        err instanceof StateSchemaError
          ? err.message
          : `session runtime init failed: ${(err as Error).name}`;
    }
    return runtime;
  };

  /** T13 runtime source for the recall tools (lazy, same as event handlers). */
  const getRecallRuntime = (): RecallRuntime | undefined => {
    const rt = runtime;
    if (!rt?.retrieval) return undefined;
    return { coordinator: rt.retrieval, adapter: rt.retrieval.adapter };
  };
  const getHeldReason = (): string | undefined =>
    runtime?.retrievalHeldReason ?? runtimeError;
  const recallDeps = (): RecallToolsDeps | undefined => {
    const configResult = loadConfig();
    if (!configResult.ok) return undefined;
    const config = configResult.config;
    const rt = runtime;
    return {
      getRuntime: getRecallRuntime,
      getHeldReason,
      privateMode: () => config.privateMode,
      ...(rt?.tombstoneCache ? { tombstoneCache: rt.tombstoneCache } : {}),
      deadlineMs: config.budgets.ragDeadlineMs,
    };
  };

  // T13: explicit recall tools — same scope/privacy/guard pipeline as the
  // automatic injection, never a bypass (private mode, tombstones, scope).
  // Deps resolve lazily per call (runtime is built at first session event).
  pi.registerTool(buildMemorySearchTool(recallDeps));
  pi.registerTool(buildMemoryReadTool(recallDeps));

  // T16: agent board tools. Sends ride the durable outbox (opId + created
  // persisted at enqueue, delivery by the worker's at-least-once sender);
  // list/read go through the BoardRepository's strict client-side channel
  // containment and client-side TTL. Same private-mode/hold gates as the
  // recall tools — never a bypass. The runtime source is the retrieval
  // adapter (same MCP config gating: enabled + url + auth resolve); when
  // retrieval is held, the board is held with the same sanitized reason.
  const boardDeps = (): BoardToolsDeps | undefined => {
    const configResult = loadConfig();
    if (!configResult.ok) return undefined;
    const config = configResult.config;
    const rt = runtime;
    const getBoardRuntime = (): BoardRuntime | undefined => {
      if (!rt?.retrieval?.adapter) return undefined;
      return {
        adapter: rt.retrieval.adapter,
        outbox: rt.store,
        boardEnabled: effectiveFeatures(config).board,
        ...(rt.delivery ? { delivery: rt.delivery } : {}),
      };
    };
    return {
      getRuntime: getBoardRuntime,
      // Board tools carry the delivery hold reason too: an unconfigured
      // backend credential must surface its real cause, not a generic hold.
      getHeldReason: () =>
        runtime?.retrievalHeldReason ??
        runtime?.deliveryHeldReason ??
        runtimeError,
      privateMode: () => config.privateMode,
      redact: createRedactor(),
    };
  };
  pi.registerTool(buildBoardSendTool(boardDeps));
  pi.registerTool(buildBoardListTool(boardDeps));
  pi.registerTool(buildBoardReadTool(boardDeps));
  // T17: delivery surface — bounded bounded-buffer inbox + LOCAL-ONLY ack
  // (no remote mutation; same private-mode/hold gates as the other tools).
  pi.registerTool(buildBoardInboxTool(boardDeps));
  pi.registerTool(buildBoardAckTool(boardDeps));

  // No-UI access: handlers only read ctx.sessionManager / ctx.cwd.
  pi.on("session_start", async (event, ctx) => {
    const rt = get(ctx.cwd);
    rt?.coordinator.onSessionStart(ctx, event);
    if (rt?.observer) {
      rt.observer.sessionId = rt.coordinator.sessionId ?? "pending";
      rt.observer.refreshIdentity(
        rt.coordinator.sessionId ?? "pending",
        rt.coordinator.branchId ?? undefined,
      );
      rt.observer.setProvider({
        entries: () => toSourceViews(ctx.sessionManager.getEntries()),
      });
    }
    // T14: backup identity tracks the session/branch like the observer.
    rt?.backup?.refreshIdentity(
      rt.coordinator.sessionId ?? "pending",
      rt.coordinator.branchId ?? undefined,
    );
    // T17: start bounded board delivery for the current generation (a
    // stop() at switch/fork/tree/shutdown is undone here by a fresh poller
    // over the same durable state file; dedupe absorbs anything handled).
    rt?.delivery?.start();
  });
  // T12: per-input retrieval. `input` handlers are awaited by Pi BEFORE the
  // first LLM call — including queued (steer/followUp) inputs — so the
  // evidence pack exists before `before_provider_request` (verified ordering,
  // mcp-contracts.md §6). Tool-loop LLM calls emit no `input` event and never
  // repeat a cycle. Injection of the pack is the T13 context injector; this
  // handler only guarantees one logical retrieval cycle per eligible input.
  pi.on("input", async (event, ctx) => {
    const rt = get(ctx.cwd);
    if (!rt?.retrieval) return;
    rt.retrieval.setGeneration(rt.coordinator.generation);
    await rt.retrieval.retrieve(
      event.text,
      event.streamingBehavior,
      event.source,
    );
  });
  // T13: fresh-turn injection. The awaited `input` handler above has already
  // completed the retrieval cycle (Pi ordering: input → expansion →
  // before_agent_start), so the fresh pack for THIS prompt is pending and is
  // consumed here; the single custom message is appended persistently by Pi
  // exactly once per pack. No matching fresh pack → undefined (fail closed:
  // no injection, pack fails closed at settle if it exists at all).
  pi.on("before_agent_start", (event, ctx) => {
    const rt = get(ctx.cwd);
    if (!rt?.retrieval) return undefined;
    const injector = new EvidenceInjector(rt.retrieval.registry);
    return injector.onBeforeAgentStart(event.prompt) ?? undefined;
  });
  // T13: queued steer/followUp injection. The context event fires per
  // provider call (including tool loops) with a cloned message list; the
  // registry matches the CONSUMED input (last user message + new-occurrence
  // barrier) and dedupes by inputId, so tool-loop replays never re-inject
  // and the returned replacement is transient (no persistent duplicates).
  pi.on("context", (event, ctx) => {
    const rt = get(ctx.cwd);
    if (!rt?.retrieval) return undefined;
    const injector = new EvidenceInjector(rt.retrieval.registry);
    return injector.onContext(event.messages) ?? undefined;
  });
  pi.on("agent_settled", async (event, ctx) => {
    // Fail closed: unmatched pending packs are dropped at run settle with a
    // visible degraded note — never carried into a later unrelated turn.
    const dropped = runtime?.retrieval?.registry.dropUnmatched() ?? [];
    retrievalDropNote =
      dropped.length > 0
        ? `unmatched evidence pack(s) dropped at run settle: ${dropped.length}`
        : undefined;
    runtime?.observer?.onAgentSettled();
    // T14: incremental backup flush over the full session tree (the capture
    // engine's coverage cursor decides what is new — private mode and
    // exclusions re-checked inside).
    try {
      runtime?.backup?.capture(ctx.sessionManager.getEntries());
    } catch (err) {
      if (runtime?.backup) runtime.backup.lastError = (err as Error).name;
    }
  });
  pi.on("session_before_compact", async (event) => {
    // Bounded flush; NEVER returns cancel — compaction always proceeds
    // (decisions.md #6). Unprocessed ranges stay durably pending.
    await runtime?.observer?.onBeforeCompact(event.signal);
    // T14: capture is a bounded local enqueue (no network, no model call);
    // failures never cancel compaction — the coverage cursor stays put and
    // the next flush re-derives.
    try {
      runtime?.backup?.capture(event.branchEntries);
    } catch {
      // visible via backup pendingStatus
    }
    return {};
  });
  pi.on("session_before_fork", async () => {
    // No ctx needed: fork snapshot point; generation re-mints at session_start.
    runtime?.coordinator.onBeforeFork();
    // T17: stop board polling for the old generation (§133, best-effort).
    runtime?.delivery?.stop();
  });
  pi.on("session_before_switch", async () => {
    runtime?.coordinator.onBeforeSwitch();
    // T17: stop board polling for the old generation (§133, best-effort).
    runtime?.delivery?.stop();
  });
  pi.on("session_before_tree", async (event) => {
    runtime?.coordinator.onBeforeTree(event.preparation, event.signal);
    // T17: stop board polling for the old generation (§133, best-effort).
    runtime?.delivery?.stop();
  });
  pi.on("session_tree", async (event, ctx) => {
    runtime?.coordinator.onTree(ctx, event.oldLeafId, event.newLeafId);
    // T09 follow-up (closed in T10): branchId feeds the idempotency key, so
    // it must track the post-navigation branch, not the start-time branch.
    if (runtime?.observer) {
      runtime.observer.refreshIdentity(
        runtime.coordinator.sessionId ?? "pending",
        runtime.coordinator.branchId ?? undefined,
      );
    }
    // T14: branch navigation re-derives uncovered entries on the new branch;
    // shared-ancestor coverage lives in the coordinator's durable registry.
    runtime?.backup?.refreshIdentity(
      runtime.coordinator.sessionId ?? "pending",
      runtime.coordinator.branchId ?? undefined,
    );
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // T14: final backup flush before teardown (best-effort; the coverage
    // cursor guarantees a later resume never misses or duplicates entries).
    try {
      runtime?.backup?.capture(ctx.sessionManager.getEntries());
    } catch {
      // visible via backup pendingStatus
    }
    runtime?.observer?.dispose();
    runtime?.liveGate?.dispose();
    // Q04b: release the audit lock at teardown so a next session's store is
    // never a second writer against a stale live lock (single-owner cleanup).
    try {
      runtime?.audit?.close();
    } catch {
      /* best effort; close never throws today */
    }
    runtime?.coordinator.onShutdown();
    // T17: session teardown stops delivery and all background board work
    // (PRD T17: private mode and teardown stop delivery + background
    // resources; the durable state file makes the next session's restart
    // replay-safe with no repeated logical notifications).
    runtime?.delivery?.stop();
  });

  return { getRuntime: get, getRuntimeError: () => runtimeError };
}

export default function kiwifsMemory(pi: ExtensionAPI): void {
  // T18 chunk 2: build the runtime box FIRST so command handlers share the
  // same lazily-built runtime as the event handlers (runtime is constructed
  // at the first session event, or at the first command that needs it).
  const runtimeBox = registerSessionHandlers(pi, (cwd) =>
    buildSessionRuntime(cwd),
  );

  /** Command-side gates: config must be valid, enabled and not private. */
  const configGate = ():
    | { ok: false; notice: string }
    | { ok: true; config: MemoryConfig; configFile: string | undefined } => {
    const result = loadConfig();
    if (!result.ok) return { ok: false, notice: "config: INVALID" };
    if (!result.config.enabled)
      return { ok: false, notice: "extension disabled" };
    if (result.config.privateMode)
      return {
        ok: false,
        notice:
          "private mode active — all domains hold (zero reads/writes); use /kiwifs-private-mode off to resume",
      };
    return { ok: true, config: result.config, configFile: result.file };
  };

  /** T18: control surface for the command's session (lazy runtime). */
  const controlSurface = (cwd: string): RuntimeControlSurface =>
    buildRuntimeControlSurface({
      configFile: loadConfig().file,
      getRetrieval: () => runtimeBox.getRuntime(cwd)?.retrieval,
      getGeneration: () =>
        runtimeBox.getRuntime(cwd)?.coordinator.generation ?? 0,
      // Q02c: push the transition into the runtime's shared live gate so
      // cancel subscribers (in-flight model/retrieval work) are notified at
      // transition time; the gate fail-closed re-reads config itself.
      notifyPrivateTransition: (value) => {
        runtimeBox.getRuntime(cwd)?.liveGate?.notifyTransition();
      },
    });

  pi.registerCommand("kiwifs-status", {
    description: "Show KiwiFS memory extension status",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(resolveStatusText(), "info");
      }
    },
  });

  // T15: backup verification and approved recovery path. Read-only against
  // the backend (kiwi_read only); export is non-destructive — it writes
  // ONLY to an explicit new destination directory and never overwrites
  // existing sessions or paths (architecture.md §7; restore-into-Pi is
  // deferred, §13 row 20, and is not attempted here).
  pi.registerCommand("kiwifs-backup-verify", {
    description:
      "Verify a KiwiFS transcript backup (checksums, completeness, branch links); optional export to a NEW directory",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sessionId = parts[0];
      const exportDir = parts[1];
      const configResult = loadConfig();
      if (!configResult.ok) {
        if (ctx.hasUI)
          ctx.ui.notify("config: INVALID — cannot verify", "error");
        return;
      }
      const config = configResult.config;
      if (!config.enabled) {
        if (ctx.hasUI)
          ctx.ui.notify("extension disabled — nothing to verify", "info");
        return;
      }
      if (config.privateMode) {
        // docs/privacy.md: private mode holds all network reads and writes in
        // every feature domain, including backup. Verification reads the
        // delivered tree from the backend, so it must hold here.
        if (ctx.hasUI)
          ctx.ui.notify(
            "private mode active — backup verify holds all backend reads",
            "info",
          );
        return;
      }
      const scope = resolveRecordScope(config, ctx.cwd);
      if (!scope.ok || !scope.scope.startsWith("project/")) {
        if (ctx.hasUI)
          ctx.ui.notify(
            scope.ok
              ? "backup verify requires a resolved project scope"
              : scope.reason,
            "error",
          );
        return;
      }
      if (!sessionId) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "usage: /kiwifs-backup-verify <session-id> [export-dir]\nThe export dir must NOT exist — export never overwrites.",
            "info",
          );
        return;
      }
      try {
        // Path-safety gate inside the guarded block (PathEscapeError →
        // visible failure, never an unhandled crash).
        const projectId = validateProjectId(
          scope.scope.slice("project/".length),
        );
        // Read-only backend (no ledger: reads mint no opIds).
        const adapter = openConfiguredBackend(config, {
          record: () => {},
          assertPersisted: () => {},
        });
        if (!adapter) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "backend not configured or credential unresolved — verification unavailable (retryable)",
              "error",
            );
          return;
        }
        await adapter.connect();
        const result = await verifyRemoteBackup(adapter, projectId, sessionId, {
          expectedScope: scope.scope,
        });
        if (result.state === "missing") {
          if (ctx.hasUI) ctx.ui.notify(`backup: ${result.detail}`, "info");
          return;
        }
        if (result.state === "invalid") {
          if (ctx.hasUI)
            ctx.ui.notify(
              `backup INVALID: ${result.issue.code} — ${result.issue.detail}`,
              "error",
            );
          return;
        }
        const v = result.verification;
        let report = v.ok
          ? "backup VERIFIED"
          : `backup FAILED (${v.issues.length} issue(s))`;
        report += `\nsession: ${v.manifest.sessionId}  scope: ${v.manifest.scope}`;
        report += `\nentries: ${v.coveredEntryIds.length}/${v.manifest.coveredRange.entryCount}  chunks: ${v.manifest.chunks.length}`;
        report += `\nfidelity: ${v.fidelity}`;
        for (const issue of v.issues.slice(0, 10)) {
          report += `\n- ${issue.code}: ${issue.detail}`;
        }
        if (v.issues.length > 10) {
          report += `\n- … and ${v.issues.length - 10} more`;
        }
        if (exportDir !== undefined) {
          try {
            const ex = exportBackup({
              verification: v,
              chunks: result.chunks,
              destination: exportDir,
            });
            report += `\nexport: OK — ${ex.files.length} file(s) written to ${ex.destination} (non-destructive, new directory only)`;
          } catch (err) {
            if (err instanceof ExportRefusedError) {
              report += `\nexport: REFUSED — ${(err as Error).message}`;
            } else {
              report += `\nexport: FAILED — ${(err as Error).name}`;
            }
          }
        }
        if (ctx.hasUI) ctx.ui.notify(report, v.ok ? "info" : "error");
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `backup verify failed: ${(err as Error).name} (backend unreachable?)`,
            "error",
          );
      } finally {
        // Best-effort close; the adapter has no disconnect — drop the ref.
      }
    },
  });

  // ---- T18 chunk 2: command wiring (all headless/RPC safe) --------------

  // Private-mode toggle wired to the chunk-1 control surface: the config
  // edit persists FIRST (atomic, validated); enabling then cancels pending
  // retrieval (generation bump) so no in-flight evidence pack survives the
  // flip. Live gates re-read config per boundary — no restart needed.
  pi.registerCommand("kiwifs-private-mode", {
    description:
      "Show or toggle KiwiFS private mode (on|off|status) — private mode holds ALL reads/writes in every domain",
    handler: async (args, ctx) => {
      const mode = (args ?? "").trim().toLowerCase() || "status";
      if (mode !== "on" && mode !== "off" && mode !== "status") {
        if (ctx.hasUI)
          ctx.ui.notify("usage: /kiwifs-private-mode on|off|status", "info");
        return;
      }
      const result = loadConfig();
      if (mode === "status") {
        if (ctx.hasUI) {
          if (!result.ok) ctx.ui.notify("config: INVALID", "error");
          else
            ctx.ui.notify(
              `private mode: ${result.config.privateMode ? "ON" : "OFF"}${
                result.config.privateMode
                  ? " — all domains hold (zero reads/writes)"
                  : ""
              }`,
              "info",
            );
        }
        return;
      }
      const cwd = ctx.cwd;
      const surface = controlSurface(cwd);
      const setResult =
        mode === "on"
          ? surface.setPrivateMode(true)
          : surface.setPrivateMode(false);
      let text = setResult.ok
        ? setResult.detail
        : `NOT changed — ${setResult.reason}`;
      if (setResult.ok && mode === "on") {
        // Enable order (T18): persist file first (done), then invalidate
        // in-flight retrieval so stale evidence cannot surface afterwards.
        const cancel = surface.cancelPendingRetrieval();
        text +=
          cancel.ok && cancel.detail
            ? `; ${cancel.detail}`
            : "; no pending retrieval to cancel";
      }
      if (ctx.hasUI) ctx.ui.notify(text, setResult.ok ? "info" : "error");
    },
  });

  // Manual extraction trigger (same pipeline as the automatic settle path).
  pi.registerCommand("kiwifs-extract-now", {
    description:
      "Trigger one KiwiFS observation extraction cycle now (bounded; sanitized summary)",
    handler: async (_args, ctx) => {
      const gate = configGate();
      if (!gate.ok) {
        if (ctx.hasUI) ctx.ui.notify(gate.notice, "info");
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const err = runtimeBox.getRuntimeError();
      const observer = rt?.observer;
      if (!observer || err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `observer not active${err ? ` — ${err}` : " (held: scope/feature/model unavailable)"}`,
            "info",
          );
        return;
      }
      const s = observer.extractNow();
      if (ctx.hasUI)
        ctx.ui.notify(
          `manual extraction: scheduled=${s.scheduled} deferred=${s.deferred} retried=${s.retried}${s.skippedReason ? ` skipped=${s.skippedReason}` : ""}`,
          "info",
        );
    },
  });

  // Manual reflection trigger (bypasses the [P] threshold, NOT the gates).
  pi.registerCommand("kiwifs-reflect-now", {
    description:
      "Trigger a KiwiFS reflection run now (bounded; sanitized summary; approval still gated)",
    handler: async (_args, ctx) => {
      const gate = configGate();
      if (!gate.ok) {
        if (ctx.hasUI) ctx.ui.notify(gate.notice, "info");
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const reflection = rt?.reflection;
      if (!reflection) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "reflection not active (observation feature off or init failed)",
            "info",
          );
        return;
      }
      try {
        const r = await reflection.reflectNow();
        if (ctx.hasUI)
          ctx.ui.notify(
            r.ran
              ? "reflection run complete (record set updated; proposals remain approval-gated)"
              : `reflection skipped: ${r.skippedReason ?? "unknown"}`,
            "info",
          );
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `reflection failed: ${errorName(err)} (no content disclosed)`,
            "error",
          );
      }
    },
  });

  // Proposal lifecycle commands: approve / reject / undo — verified
  // transitions via the T11 lifecycle (fresh reads, read-back verification,
  // serialized locally). Stale states fail visibly, never silently.
  pi.registerCommand("kiwifs-proposal", {
    description:
      "Approve, reject or undo a KiwiFS merge proposal: /kiwifs-proposal <approve|reject|undo> <proposal-path> [reason…]",
    handler: async (args, ctx) => {
      // Q03a: proposal transitions are record-mutating — explicit
      // confirmation everywhere: UI confirm dialog, or the literal --yes
      // argument in headless/RPC mode. Refusal performs zero writes and
      // zero network mutations.
      const parts = (args ?? "").trim().split(/\s+/);
      const headlessYes = parts.includes("--yes");
      const cleanParts = parts.filter((p) => p !== "--yes");
      const action = cleanParts.shift();
      const proposalPath = cleanParts.shift();
      const reason = cleanParts.join(" ") || undefined;
      if (
        (action !== "approve" && action !== "reject" && action !== "undo") ||
        !proposalPath
      ) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "usage: /kiwifs-proposal <approve|reject|undo> <proposal-path> [reason…]",
            "info",
          );
        return;
      }
      if (ctx.hasUI) {
        const proceed = await ctx.ui.confirm(
          `Proposal ${action}`,
          `${action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Undo"} merge proposal ${proposalPath}? This rewrites the targeted records (verified transitions; stale states fail visibly).`,
        );
        if (!proceed) {
          ctx.ui.notify("proposal cancelled", "info");
          return;
        }
      } else if (!headlessYes) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "refused — headless proposal transitions require --yes (record-mutating command)",
            "error",
          );
        return;
      }
      const gate = configGate();
      if (!gate.ok) {
        if (ctx.hasUI) ctx.ui.notify(gate.notice, "info");
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const lifecycle = rt?.lifecycle;
      if (!lifecycle) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "proposal lifecycle unavailable (backend or credential unconfigured)",
            "error",
          );
        return;
      }
      try {
        const opts = {
          actor: "user-command",
          ...(reason !== undefined ? { reason } : {}),
        };
        const r =
          action === "approve"
            ? await lifecycle.approve(proposalPath, opts)
            : action === "reject"
              ? await lifecycle.reject(proposalPath, opts)
              : await lifecycle.undo(proposalPath, opts);
        if (ctx.hasUI)
          ctx.ui.notify(
            `proposal ${action} ${r.applied}: targets=${r.targets.length} (${r.proposalPath})`,
            "info",
          );
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            err instanceof StaleProposalError
              ? (err as Error).message
              : `proposal ${action} failed: ${errorName(err)}`,
            "error",
          );
      }
    },
  });

  // Manual forget gates shared by forget/forget-undo handlers.
  const manualOpsGate = (
    ctx: ExtensionCommandContext,
  ):
    | {
        config: MemoryConfig;
        opLog: ManualOpLog;
        manual: ReturnType<typeof createManualOps>;
      }
    | undefined => {
    const gate = configGate();
    if (!gate.ok) {
      if (ctx.hasUI) ctx.ui.notify(gate.notice, "info");
      return undefined;
    }
    if (!gate.config.mcp.url || !gate.config.mcp.auth) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "backend not configured (mcp.url/mcp.auth) — manual ops unavailable",
          "error",
        );
      return undefined;
    }
    const opLog = new ManualOpLog(resolveStateDir(ctx.cwd));
    return {
      config: gate.config,
      opLog,
      manual: createManualOps(
        { url: gate.config.mcp.url, auth: gate.config.mcp.auth },
        opLog,
      ),
    };
  };

  // Reversible logical forget (B6: nothing is deleted; body preserved).
  // UI sessions require an explicit confirm; headless/RPC runs act on the
  // explicit args (documented). Tombstone cache refresh + cached evidence
  // pack drop follow every successful forget.
  pi.registerCommand("kiwifs-forget", {
    description:
      "Forget a KiwiFS memory record (REVERSIBLE: marks superseded, body preserved): /kiwifs-forget <path> [reason…]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      // Headless/RPC requires the explicit --yes token (review fix: record-
      // mutating commands must not execute without confirmation anywhere).
      const headlessYes = parts.includes("--yes");
      const path = parts.filter((p) => p !== "--yes").shift();
      const reason =
        parts
          .filter((p) => p !== "--yes")
          .slice(1)
          .join(" ") || undefined;
      if (!path) {
        if (ctx.hasUI)
          ctx.ui.notify("usage: /kiwifs-forget <path> [reason…]", "info");
        return;
      }
      const g = manualOpsGate(ctx);
      if (!g) return;
      if (ctx.hasUI) {
        const proceed = await ctx.ui.confirm(
          "Forget memory record",
          `Mark ${path} superseded? Body is preserved; reversible via /kiwifs-forget-undo.`,
        );
        if (!proceed) {
          ctx.ui.notify("forget cancelled", "info");
          return;
        }
      } else if (!headlessYes) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "refused — headless forget requires --yes (record-mutating command)",
            "error",
          );
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const result = await forgetMemoryPath({
        opLog: g.opLog,
        openStore: g.manual.openStore,
        path,
        ...(reason !== undefined ? { reason } : {}),
        actor: "user-command",
        ...(rt?.tombstoneCache ? { tombstoneCache: rt.tombstoneCache } : {}),
        ...(rt?.retrieval ? { registry: rt.retrieval.registry } : {}),
        // Q04c: sanitized command event via the production sink.
        ...(rt?.audit ? { audit: rt.audit } : {}),
      });
      if (ctx.hasUI)
        ctx.ui.notify(
          result.ok ? result.detail : `NOT forgotten — ${result.reason}`,
          result.ok ? "info" : "error",
        );
    },
  });

  // Verified restore: read-back-verified status flip with provenance.
  pi.registerCommand("kiwifs-forget-undo", {
    description:
      "Restore a forgotten KiwiFS record to active (read-back verified): /kiwifs-forget-undo <path>",
    handler: async (args, ctx) => {
      // Q03a: forget-undo is record-mutating — explicit confirmation
      // everywhere: UI confirm dialog, or the literal --yes argument in
      // headless/RPC mode (same policy as /kiwifs-forget). Refusal performs
      // zero writes and zero network mutations.
      const parts = (args ?? "").trim().split(/\s+/);
      const headlessYes = parts.includes("--yes");
      const path = parts.filter((p) => p !== "--yes")[0];
      if (!path) {
        if (ctx.hasUI)
          ctx.ui.notify("usage: /kiwifs-forget-undo <path>", "info");
        return;
      }
      if (ctx.hasUI) {
        const proceed = await ctx.ui.confirm(
          "Restore forgotten record",
          `Mark ${path} active again? Adds a provenance line; verified by read-back.`,
        );
        if (!proceed) {
          ctx.ui.notify("forget-undo cancelled", "info");
          return;
        }
      } else if (!headlessYes) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "refused — headless forget-undo requires --yes (record-mutating command)",
            "error",
          );
        return;
      }
      const g = manualOpsGate(ctx);
      if (!g) return;
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const result = await unforgetMemoryPath({
        opLog: g.opLog,
        openStore: g.manual.openStore,
        path,
        actor: "user-command",
        ...(rt?.tombstoneCache ? { tombstoneCache: rt.tombstoneCache } : {}),
        // Q04c: sanitized command event via the production sink.
        ...(rt?.audit ? { audit: rt.audit } : {}),
      });
      if (ctx.hasUI)
        ctx.ui.notify(
          result.ok ? result.detail : `NOT restored — ${result.reason}`,
          result.ok ? "info" : "error",
        );
    },
  });

  // Q05P2: explicit personal note — the ONLY sanctioned personal-scope
  // write surface (docs/decisions.md #13, user-approved). A user command,
  // never an automatic capture/reflection/backup path and never a tool the
  // model can call: nothing promotes project content and no model call is
  // made by saving. UI sessions confirm via a preview dialog of the
  // REDACTED statement; headless/RPC requires the literal --yes token.
  // Redaction happens BEFORE the confirm preview and before enqueue; the
  // job reuses the durable outbox (opId persisted before any side effect).
  pi.registerCommand("kiwifs-personal-note", {
    description:
      "Save ONE note to personal-global memory (explicit user action; confirmed; never automatic): /kiwifs-personal-note <statement…> [--entry id1,id2] [--yes]",
    handler: async (args, ctx) => {
      const gate = configGate();
      if (!gate.ok) {
        if (ctx.hasUI) ctx.ui.notify(gate.notice, "info");
        return;
      }
      if (!gate.config.scopes.allowPersonalGlobal) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "personal-global scope disabled (scopes.allowPersonalGlobal) — note not saved",
            "info",
          );
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const headlessYes = parts.includes("--yes");
      const rest = parts.filter((p) => p !== "--yes");
      const entryIds: string[] = [];
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i]!;
        if (w === "--entry") {
          i++;
          entryIds.push(
            ...(rest[i] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          continue;
        }
        if (w.startsWith("--entry=")) {
          entryIds.push(
            ...w
              .slice("--entry=".length)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          continue;
        }
        words.push(w);
      }
      const statement = words.join(" ").trim();
      if (!statement) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "usage: /kiwifs-personal-note <statement…> [--entry id1,id2] [--yes]",
            "info",
          );
        return;
      }
      // Redact BEFORE the preview and before any durable write (decisions
      // #10: redact before outbound). Fail closed on unclassifiable content.
      const red = redactText(statement);
      if (!red.ok) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "held — content could not be classified safely; nothing was saved",
            "error",
          );
        return;
      }
      const preview =
        red.content.length > 200
          ? `${red.content.slice(0, 200)}…`
          : red.content;
      const redactions =
        red.findings.length > 0
          ? ` (${red.findings.length} redaction${red.findings.length === 1 ? "" : "s"} applied)`
          : "";
      if (ctx.hasUI) {
        const proceed = await ctx.ui.confirm(
          "Save personal note",
          `Statement${redactions}: ${preview}\n\nScope: personal-global (your own memory space). Saved to the durable outbox and delivered idempotently. Nothing is promoted from project memory and no model call is made.`,
        );
        if (!proceed) {
          ctx.ui.notify("personal note cancelled", "info");
          return;
        }
      } else if (!headlessYes) {
        // Headless must not touch the UI: notify only through the guarded
        // path (hasUI is false here; keep the branch UI-free).
        if (ctx.hasUI)
          ctx.ui.notify(
            "refused — headless personal-note requires --yes (record-mutating command)",
            "error",
          );
        return;
      }
      // Provenance: the live session id when available; "pending" matches
      // the existing convention for a not-yet-reported session id.
      let sessionId = "pending";
      try {
        sessionId = ctx.sessionManager.getSessionId() ?? "pending";
      } catch {
        // fixture/headless contexts without a session manager
      }
      let enqueueInput;
      try {
        enqueueInput = buildExplicitPersonalEnqueue({
          sessionId,
          entryIds,
          statement: red.content,
        });
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            err instanceof ExplicitPersonalInputError
              ? (err as Error).message
              : `personal note refused: ${errorName(err)}`,
            "error",
          );
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      let owned: DurableOutbox | undefined;
      let outbox = rt?.store;
      if (!outbox) {
        // Durable even when the session runtime is not active: the job sits
        // pending at the same state path and is delivered by the next active
        // runtime's worker (scope `personal` is never held on project
        // identity). No network attempt happens here.
        try {
          owned = DurableOutbox.open(join(resolveStateDir(ctx.cwd), "outbox"));
          outbox = owned;
        } catch (err) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `personal note not saved: ${errorName(err)}`,
              "error",
            );
          return;
        }
      }
      try {
        const job = outbox.enqueue(enqueueInput);
        recordPersonalNoteAudit(rt?.audit, ctx.cwd, job.opId);
        if (ctx.hasUI)
          ctx.ui.notify(
            `personal note saved (scope: personal; queued for idempotent delivery${redactions})`,
            "info",
          );
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            err instanceof OutboxError
              ? (err as Error).message
              : `personal note failed: ${errorName(err)}`,
            "error",
          );
      } finally {
        owned?.close();
      }
    },
  });

  // Q05R3 audit fallback (Q04 promised coverage): the durable
  // open-enqueue-close fallback path runs OUTSIDE the session runtime, so
  // rt?.audit is undefined there and the sanitized personal-note event was
  // previously dropped. Record through the SAME durable sink path (the
  // store degrades to a bounded in-memory buffer when another owner holds
  // the lock; record() never throws). Metadata-only: the opId, never the
  // statement.
  const recordPersonalNoteAudit = (
    rtAudit: AuditSinkLike | undefined,
    cwd: string,
    opId: string,
  ): void => {
    if (rtAudit) {
      rtAudit.record({
        kind: "command",
        feature: "commands",
        decision: "ok (personal-note; scope personal; user-confirmed)",
        targetId: opId,
      });
      return;
    }
    let fallback: FileAuditStore | undefined;
    try {
      fallback = new FileAuditStore({
        path: join(resolveStateDir(cwd), "audit.log"),
      });
    } catch {
      return; // audit is best-effort; never block the durable enqueue
    }
    try {
      fallback.record({
        kind: "command",
        feature: "commands",
        decision: "ok (personal-note; scope personal; user-confirmed)",
        targetId: opId,
      });
    } finally {
      fallback.close();
    }
  };

  // MANUAL REMOTE board cleanup (Q05R3; architecture.md §8 F8, §13 row 13;
  // decisions.md #14 — user-approved): preview → explicit confirm → guarded
  // delete of THIS sender's own TTL-expired or locally-acked messages past
  // the 30-day grace. DISTINCT from /kiwifs-board-gc below: that command
  // keeps its local-only prune semantics and its `--yes` flag; `--yes` here
  // is REFUSED so an old local-prune flag can never trigger a remote
  // delete. Headless mode is a two-step flow: a plain preview run prints a
  // confirmation token binding the EXACT candidate set; only
  // `--confirm <token>` with a token matching a FRESH re-plan executes
  // (never broadens after confirmation). TUI mode previews + ui.confirm
  // binds the exact in-memory preview. Per-delete fresh rechecks,
  // persist-before-side-effect opIds, visible skips, bounded deletes and
  // the no-CAS/no-purge/no-secure-erasure disclosures are enforced by
  // executeBoardCleanup (Q05R2) — this handler never deletes directly.
  pi.registerCommand("kiwifs-board-cleanup", {
    description:
      "Preview and, after explicit confirmation, manually delete YOUR OWN board messages that are BOTH client-TTL-expired AND locally acked on the REMOTE board (local delivery state untouched; /kiwifs-board-gc is the separate local-only prune): /kiwifs-board-cleanup <from> [--confirm bc-<token>]",
    handler: async (args, ctx) => {
      // ui.notify is part of every run mode (TUI/RPC/json/print); dialog
      // methods (confirm) are guarded by ctx.hasUI. The try/catch keeps a
      // bare headless host that throws on ui access from crashing a
      // preview/refusal.
      const notify = (message: string, level: "info" | "error"): void => {
        try {
          ctx.ui.notify(message, level);
        } catch {
          /* headless host without a UI object — nothing to notify into */
        }
      };
      const gate = configGate();
      if (!gate.ok) {
        notify(gate.notice, "info");
        return;
      }
      if (!effectiveFeatures(gate.config).board) {
        notify("board feature disabled (features.board)", "info");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      // Headless `--yes` is deliberately NOT accepted: it is the local
      // /kiwifs-board-gc flag, and accepting it here would let a stale
      // local-prune habit delete remote board messages.
      if (parts.includes("--yes")) {
        notify(
          "refused — --yes belongs to /kiwifs-board-gc (local prune only); remote cleanup requires --confirm <token> from a preview",
          "error",
        );
        return;
      }
      let confirmToken: string | undefined;
      const confirmIdx = parts.indexOf("--confirm");
      if (confirmIdx >= 0) {
        confirmToken = parts[confirmIdx + 1] ?? "";
      }
      const tokenArgIdx = confirmIdx >= 0 ? confirmIdx + 1 : -1;
      const positional = parts.filter(
        (p, i) => p !== "--confirm" && i !== tokenArgIdx,
      );
      const ownFrom = positional[0] ?? "";
      if (!ownFrom) {
        notify(
          "usage: /kiwifs-board-cleanup <from> [--confirm bc-<token>] — <from> is YOUR board sender identity (ownership is never guessed)",
          "info",
        );
        return;
      }
      try {
        validateId("from", ownFrom);
      } catch (err) {
        notify(
          `sender identity refused: ${(err as PathEscapeError).message}`,
          "error",
        );
        return;
      }
      const rt = runtimeBox.getRuntime(ctx.cwd);
      // Durable ledger for the delete opIds: the executor mints interactive
      // opIds (NOT outbox job ids), so they persist in the dedicated durable
      // board-cleanup op log (append + fsync, 0o600) BEFORE each delete —
      // same rule as ManualOpLog (forget) and ProposalOpLog (lifecycle).
      // A corrupt log fails closed: no remote deletes.
      let opLog: BoardCleanupOpLog;
      const stateDir = resolveStateDir(ctx.cwd);
      try {
        opLog = new BoardCleanupOpLog(stateDir);
      } catch (err) {
        notify(
          `board cleanup unavailable: durable opId ledger failed to open (${errorName(err)})`,
          "error",
        );
        return;
      }
      const ledger = opLog.ledger();
      // Live private-mode gate re-reads config per check (same wiring as
      // board delivery; a persisted flip takes effect without a restart).
      const repoGate = {
        get isPrivate() {
          const r = loadConfig();
          return !r.ok || r.config.privateMode;
        },
      };
      const adapter = openConfiguredBackend(gate.config, ledger);
      if (!adapter) {
        notify(
          "backend not configured or credential unresolved — board cleanup unavailable (retryable)",
          "error",
        );
        return;
      }
      const repo = new BoardRepository(adapter, { privateMode: repoGate });
      // Local ack evidence comes ONLY from THIS consumer's own durable
      // board delivery state file — the SAME state the delivery runtime
      // persists to and reloads — read here FRESH, read-only and
      // fail-closed (corrupt/newer schema → NO ack evidence; with the
      // conjunctive §8 predicate that means nothing is eligible — a
      // conservative hold). This also makes the durable acks visible in
      // headless runs where the delivery runtime is not active in THIS
      // process. Acks are never inferred from anything else.
      const durableAcks = readDurableAckState(
        join(stateDir, "board"),
        gate.config.board?.consumerId,
      );
      const ackStateActive = durableAcks !== undefined;
      const acked = (msgId: string): number | undefined =>
        durableAcks?.get(msgId);
      try {
        await adapter.connect();
        const preview = await planBoardCleanup(repo, {
          ownFrom,
          acked,
        });
        if (!preview.ok) {
          notify(
            `board cleanup preview failed (${preview.reason}): ${preview.detail}`,
            "error",
          );
          return;
        }
        const token = cleanupPreviewToken(preview.candidates);
        const auditRecord = (deletedCount: number): void => {
          rt?.audit?.record({
            kind: "command",
            feature: "commands",
            decision: `ok (board-cleanup; ${deletedCount} deleted; user-confirmed)`,
          });
        };
        if (ctx.hasUI) {
          // TUI: itemize the candidate ids (bounded) and confirm on THIS
          // exact preview object — the executor binds the preview in memory.
          const items = preview.candidates
            .slice(0, 10)
            .map((c) => `- ${c.msgId} (${c.basis.join("+")})`)
            .join("\n");
          const more =
            preview.candidates.length > 10
              ? `\n- … and ${preview.candidates.length - 10} more`
              : "";
          const proceed = await ctx.ui.confirm(
            "Remote board cleanup",
            `${formatCleanupPreview(preview, {
              ...(ackStateActive ? {} : { ackStateInactive: true }),
            })}\ncandidates:\n${items || "(none)"}${more}\n\nDelete these ${preview.candidates.length} message(s) from the remote board now? This is MCP-level deletion; your LOCAL ack state is not modified and other consumers may not have acked.`,
          );
          if (!proceed) {
            notify("board cleanup cancelled — nothing was deleted", "info");
            return;
          }
          const result = await executeBoardCleanup(repo, preview, {
            ownFrom,
            acked,
            adapter,
            ledger,
            privateMode: repoGate,
          });
          notify(formatCleanupExecution(result), result.ok ? "info" : "error");
          auditRecord(result.ok ? result.deleted.length : 0);
          return;
        }
        // Headless/RPC: STEP 1 (no --confirm) is preview-only, zero deletes.
        if (confirmToken === undefined) {
          // Durable preview record: ui.notify is guaranteed in TUI and RPC
          // modes, and reaches stdout in print mode, but its delivery in
          // JSON output mode is not guaranteed — so the preview + token are
          // ALSO persisted durably (0600, content-free) and the notice
          // names the file, keeping step 2 recoverable in EVERY mode.
          const recordPath = writePreviewRecord(
            stateDir,
            token,
            preview,
            ackStateActive,
            new Date(),
          );
          notify(
            `${formatCleanupPreview(preview, {
              ...(ackStateActive ? {} : { ackStateInactive: true }),
            })}\nconfirmation token: ${token}` +
              (recordPath !== undefined
                ? `\ndurable record (token recoverable from here in every output mode, incl. JSON mode): ${recordPath}`
                : "\nNOTE: the durable preview record could not be written; the token above is only recoverable from this notice (TUI/RPC/print modes)") +
              `\nthis was PREVIEW ONLY — nothing was deleted. To delete exactly this candidate set, re-run: /kiwifs-board-cleanup ${ownFrom} --confirm ${token}`,
            "info",
          );
          return;
        }
        // STEP 2: the token must bind the FRESH plan's exact candidate set.
        // A mismatch (anything changed between preview and confirmation)
        // refuses without ANY delete — the confirmation never broadens.
        if (cleanupPreviewToken(preview.candidates) !== confirmToken) {
          notify(
            `refused — the candidate set changed since your preview (token ${confirmToken} does not bind the current plan; current token: ${token}). Re-run the preview and confirm the new token. Zero deletes were performed.`,
            "error",
          );
          return;
        }
        const result = await executeBoardCleanup(repo, preview, {
          ownFrom,
          acked,
          adapter,
          ledger,
          privateMode: repoGate,
        });
        notify(formatCleanupExecution(result), result.ok ? "info" : "error");
        auditRecord(result.ok ? result.deleted.length : 0);
      } catch (err) {
        notify(`board cleanup failed: ${errorName(err)}`, "error");
      } finally {
        // Best-effort close; the adapter has no disconnect — drop the ref.
      }
    },
  });

  // LOCAL-ONLY board GC: prunes acked/skipped entries past retention from
  // the durable delivery state file. Undelivered entries are never touched;
  // no backend call exists on this path. Explicit confirmation is REQUIRED:
  // a UI confirm dialog, or the literal --yes argument in headless/RPC mode.
  pi.registerCommand("kiwifs-board-gc", {
    description:
      "Prune acked/skipped entries older than 14d from LOCAL board delivery state (confirmed; local-only; undelivered entries untouched)",
    handler: async (args, ctx) => {
      const rt = runtimeBox.getRuntime(ctx.cwd);
      const delivery = rt?.delivery;
      if (!delivery) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "board delivery not active (feature off, held, or consumerId unset)",
            "info",
          );
        return;
      }
      let consent = false;
      if (ctx.hasUI) {
        consent = await ctx.ui.confirm(
          "Board delivery GC",
          "Prune acknowledged/skipped entries older than 14 days from LOCAL delivery state? Undelivered entries are never touched. No backend calls.",
        );
      } else {
        consent = (args ?? "").includes("--yes");
      }
      if (!consent) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "cancelled — board GC requires explicit confirmation (UI confirm or --yes)",
            "info",
          );
        return;
      }
      const removed = delivery.state.gc();
      if (ctx.hasUI)
        ctx.ui.notify(
          `board GC: removed ${removed} stale acked/skipped entr${removed === 1 ? "y" : "ies"} (local-only; undelivered entries untouched; no backend calls)`,
          "info",
        );
    },
  });

  // Queue-failure inspection: sanitized stats + quarantined job fingerprints
  // (seq/kind/attempts/name:code only — payloads are never shown).
  pi.registerCommand("kiwifs-queue", {
    description:
      "Show KiwiFS outbox queue state and quarantined job fingerprints (sanitized)",
    handler: async (_args, ctx) => {
      const store = runtimeBox.getRuntime(ctx.cwd)?.store;
      if (!store) {
        if (ctx.hasUI) ctx.ui.notify("outbox unavailable", "info");
        return;
      }
      const s = store.stats;
      let text = `outbox: pending=${s.pending} quarantined=${s.quarantined} acked=${s.acked} bytes=${s.bytes}${s.paused ? " capture=PAUSED (coverage gap)" : ""}`;
      for (const j of store.quarantined().slice(0, 20)) {
        text += `\n- seq=${j.seq} kind=${j.kind} attempts=${j.attempts} lastError=${j.lastError ?? "(none)"}`;
      }
      if (s.quarantined > 20) text += `\n- … and ${s.quarantined - 20} more`;
      if (ctx.hasUI)
        ctx.ui.notify(text, s.quarantined > 0 ? "warning" : "info");
    },
  });

  // B6 erasure disclosure: disclosure-only, zero I/O, deletes nothing.
  pi.registerCommand("kiwifs-erasure-report", {
    description:
      "Show where KiwiFS record content is retained (B6 disclosure; nothing is deleted)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(erasureReportLines().join("\n"), "info");
    },
  });
}
