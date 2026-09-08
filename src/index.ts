import { join } from "node:path";
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
  observerError: string | undefined;
  store: DurableOutbox | undefined;
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
  return {
    coordinator,
    observer,
    reflection,
    lifecycle,
    observerError,
    store,
  };
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
  lastCoordinatorError = () => runtimeError;
  lastObserverError = () => {
    if (runtimeError) return runtimeError;
    return runtime?.observerError;
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
  });
  pi.on("agent_settled", async () => {
    runtime?.observer?.onAgentSettled();
  });
  pi.on("session_before_compact", async (event) => {
    // Bounded flush; NEVER returns cancel — compaction always proceeds
    // (decisions.md #6). Unprocessed ranges stay durably pending.
    await runtime?.observer?.onBeforeCompact(event.signal);
    return {};
  });
  pi.on("session_before_fork", async () => {
    // No ctx needed: fork snapshot point; generation re-mints at session_start.
    runtime?.coordinator.onBeforeFork();
  });
  pi.on("session_before_switch", async () => {
    runtime?.coordinator.onBeforeSwitch();
  });
  pi.on("session_before_tree", async (event) => {
    runtime?.coordinator.onBeforeTree(event.preparation, event.signal);
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
  });
  pi.on("session_shutdown", async () => {
    runtime?.observer?.dispose();
    runtime?.coordinator.onShutdown();
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

  registerSessionHandlers(pi, (cwd) => buildSessionRuntime(cwd));
}
