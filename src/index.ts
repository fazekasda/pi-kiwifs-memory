import { join, dirname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import type { AuthRef } from "./config/schema.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";
import { effectiveFeatures, type MemoryConfig } from "./config/schema.ts";
import { KiwiFSAdapter } from "./backend/adapter.ts";
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
import { createRedactor } from "./privacy/redaction.ts";
import { QueryMetaTombstoneCache } from "./backend/guard.ts";
import { loadConfiguredTokenizer } from "./retrieval/tokenizer.ts";
import { validateProjectId } from "./domain/paths.ts";
import { DurableOutbox, OutboxError } from "./outbox/store.ts";
import { OutboxWorker } from "./outbox/worker.ts";
import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  DEFAULT_OUTPUT_BUDGET_TOKENS,
  ObserverScheduler,
  toSourceViews,
} from "./observation/scheduler.ts";

export const STATUS_MESSAGE =
  "KiwiFS memory extension loaded. Memory storage is not implemented yet.";

/** Last coordinator/observer init error, surfaced via status (fail-visible). */
let lastCoordinatorError: (() => string | undefined) | undefined;
let lastObserverError: (() => string | undefined) | undefined;
/** Last retrieval degradation note, surfaced via status (fail-visible, T12). */
let lastRetrievalNote: (() => string | undefined) | undefined;
/** Last tokenizer load/attach note, surfaced via status (fail-visible, T13). */
let lastTokenizerNote: (() => string | undefined) | undefined;
/** Last backup capture error/note, surfaced via status (fail-visible, T14). */
let lastBackupNote: (() => string | undefined) | undefined;
/** Last board delivery note/status, surfaced via status (fail-visible, T17). */
let lastBoardNote: (() => string | undefined) | undefined;

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
  if (obsErr) text += `\nobserver: DISABLED — ${obsErr}`;
  const retrievalNote = lastRetrievalNote?.();
  if (retrievalNote) text += `\nretrieval: degraded — ${retrievalNote}`;
  const tokenizerNote = lastTokenizerNote?.();
  if (tokenizerNote) text += `\ntokenizer: ${tokenizerNote}`;
  const backupNote = lastBackupNote?.();
  if (backupNote) text += `\nbackup: ${backupNote}`;
  const boardNote = lastBoardNote?.();
  if (boardNote) text += `\nboard delivery: ${boardNote}`;
  if (result.ok && result.config.enabled) {
    const features = effectiveFeatures(result.config);
    if (features.observation && !result.config.model.auth) {
      text +=
        "\nobserver: extraction fails closed — model.auth is not configured (no model calls)";
    }
    if (features.observation && result.config.projectIdentity === undefined) {
      text +=
        "\nobserver: DISABLED — record scope not yet resolved (projectIdentity unset; git-remote discovery lands in T18)";
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
 * Record scope for observation storage (T10). Uses the explicit
 * `projectIdentity` override when configured; otherwise the scope is not
 * yet resolved — real `git remote -v` discovery is the documented T18
 * convention. An unresolved scope is NOT a writable owner scope: rather
 * than extracting observations into jobs that can only be permanently
 * quarantined at send time (guaranteed data loss), observation is held
 * entirely until the scope resolves, and any queued job is held as a
 * retryable availability gap by the sender.
 */
function resolveRecordScope(config: MemoryConfig): string | undefined {
  if (config.projectIdentity)
    return `project/${config.projectIdentity.toLowerCase()}`;
  return undefined;
}

/**
 * Builds the observation-delivery backend from the validated config.
 * Returns undefined when MCP is not configured or the credential reference
 * does not resolve — the sender then reports a retryable availability gap
 * and jobs stay pending (never dropped, never quarantined).
 *
 * The MCP transport authenticates exclusively via `AdapterOptions.headers`
 * (src/backend/transport.ts), so the `mcp.auth` reference is resolved to a
 * bearer Authorization header here — same wiring as the live runner. The
 * secret value is resolved per delivery attempt by reference and is never
 * logged, echoed or stored.
 */
function openConfiguredBackend(
  config: MemoryConfig,
  ledger: OpIdLedger,
): KiwiFSAdapter | undefined {
  if (!config.enabled || config.mcp.url === "" || !config.mcp.auth) {
    return undefined;
  }
  const secret = resolveAuthSecret(config.mcp.auth);
  if (secret === undefined) {
    return undefined; // fail closed: unresolvable credential → retryable hold
  }
  return new KiwiFSAdapter({
    url: config.mcp.url,
    headers: { Authorization: `Bearer ${secret}` },
    ledger,
  });
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
  /** T13: advisory tombstone cache over the retrieval backend (may be undefined). */
  tombstoneCache: QueryMetaTombstoneCache | undefined;
  /** T13: tokenizer attach/load note (sanitized, status-only). */
  tokenizerNote: string | undefined;
  /** T14: incremental transcript backup capture (may be undefined). */
  backup: BackupCapture | undefined;
  backupHeldReason: string | undefined;
  /** T17: bounded board delivery + local ack state (may be undefined). */
  delivery: BoardDeliveryRuntime | undefined;
  deliveryHeldReason: string | undefined;
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
  // T10: real observation sender. When MCP is unconfigured, the credential
  // does not resolve, or the record scope is not yet resolved, the sender
  // throws the retryable SenderNotWiredError (jobs stay pending with
  // backoff — never dropped, never quarantined).
  const scope = config ? resolveRecordScope(config) : undefined;
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
              })
            : undefined;
          reflection = new ReflectionEngine({
            stateDir,
            scope,
            outbox: store,
            ...(reflect ? { reflect } : {}),
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
              openStore: (() => {
                let cached: KiwiFSAdapter | undefined;
                return async () => {
                  if (!cached) {
                    const secret = resolveAuthSecret(mcpAuth);
                    if (secret === undefined) return undefined;
                    cached = new KiwiFSAdapter({
                      url: mcpUrl,
                      headers: { Authorization: `Bearer ${secret}` },
                      ledger: {
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
                      },
                    });
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
      const adapter = new KiwiFSAdapter({
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${resolveAuthSecret(mcpAuth) ?? ""}`,
        },
        ledger: store.ledger(),
      });
      retrieval = new RetrievalCoordinator({
        adapter,
        authorizedScopes: retrievalScopes,
        deadlineMs: config.budgets.ragDeadlineMs,
        tokenCap: config.budgets.evidenceTokenCap,
        generation: coordinator.generation,
        privateMode: () => config.privateMode,
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
  if (retrieval && config?.budgets.tokenizer) {
    const spec = config.budgets.tokenizer;
    const baseDir =
      configResult.ok && configResult.file ? dirname(configResult.file) : cwd;
    void loadConfiguredTokenizer(spec, baseDir).then((result) => {
      if (result.ok) {
        retrieval?.setTokenizer(result.tokenizer);
        tokenizerNote = `model-compatible tokenizer attached (${result.tokenizer.id})`;
      } else {
        tokenizerNote = `automatic injection stays skipped — ${result.reason}`;
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
          privateMode: () => config.privateMode,
          exclusions: config.privacy.exclusions,
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
            new KiwiFSAdapter({
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${resolveAuthSecret(mcpAuth) ?? ""}`,
              },
              ledger: store.ledger(),
            }),
            { privateMode: repoGate },
          );
          delivery = new BoardDeliveryRuntime({
            stateDir: join(stateDir, "board"),
            consumerId: config.board.consumerId,
            ...(config.board.recipient !== undefined
              ? { recipient: config.board.recipient }
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
    tombstoneCache,
    tokenizerNote,
    backup,
    backupHeldReason,
    delivery,
    deliveryHeldReason,
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
 * T08 + T09: session lifecycle and observation hook wiring. Registers Pi
 * lifecycle handlers at the boundaries verified in docs/research/
 * mcp-contracts.md §6 plus the `agent_settled` and `session_before_compact`
 * observation triggers. Handlers are reentrant and never require TUI-only
 * APIs (headless/RPC safe). Runtime construction failures disable features
 * visibly instead of breaking extension startup.
 */
export function registerSessionHandlers(
  pi: ExtensionAPI,
  createRuntime: (cwd: string) => SessionRuntime,
): void {
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
    return `state=${s.runState} unread=${s.unread} consumer=${s.consumerId}${
      err ? ` lastError=${err}` : ""
    }`;
  };

  const get = (ctx: ExtensionContext): SessionRuntime | undefined => {
    if (runtime) return runtime;
    if (runtimeError) return undefined;
    try {
      runtime = createRuntime(ctx.cwd);
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
    const rt = get(ctx);
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
    const rt = get(ctx);
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
    const rt = get(ctx);
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
    const rt = get(ctx);
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
    runtime?.coordinator.onShutdown();
    // T17: session teardown stops delivery and all background board work
    // (PRD T17: private mode and teardown stop delivery + background
    // resources; the durable state file makes the next session's restart
    // replay-safe with no repeated logical notifications).
    runtime?.delivery?.stop();
  });
}

export default function kiwifsMemory(pi: ExtensionAPI): void {
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
      const scope = resolveRecordScope(config);
      if (!scope || !scope.startsWith("project/")) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "backup verify requires a resolved project scope (projectIdentity unset; git-remote discovery lands in T18)",
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
        const projectId = validateProjectId(scope.slice("project/".length));
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
          expectedScope: scope,
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

  registerSessionHandlers(pi, (cwd) => buildSessionRuntime(cwd));
}
