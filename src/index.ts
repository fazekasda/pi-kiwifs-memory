import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";
import { SessionCoordinator, StateSchemaError } from "./pi/coordinator.ts";
import { DurableOutbox, OutboxError } from "./outbox/store.ts";
import { OutboxWorker } from "./outbox/worker.ts";
import { ObserverScheduler, toSourceViews } from "./observation/scheduler.ts";
import { BackendError } from "./backend/errors.ts";

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
 * Sender stub until T10 wires the real model-observation sender: throws a
 * retryable availability error so queued jobs stay pending with backoff —
 * never quarantined, never dropped.
 */
export class SenderNotWiredError extends BackendError {
  constructor() {
    super("availability", "observation sender not wired yet (T10)");
    this.name = "SenderNotWiredError";
  }
}

/** Per-session runtime built lazily at session_start. */
interface SessionRuntime {
  coordinator: SessionCoordinator;
  observer: ObserverScheduler | undefined;
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
  const worker = store
    ? new OutboxWorker({
        store,
        send: async () => {
          throw new SenderNotWiredError();
        },
        // Sender is an availability gap, not a permanent failure: retry
        // without an attempt cap until T10 wires the real sender.
        maxAttempts: Number.MAX_SAFE_INTEGER,
      })
    : undefined;
  const coordinator = new SessionCoordinator({
    stateDir,
    ...(worker ? { onTick: () => void worker.tick() } : {}),
    ...(store ? { onRetention: () => store.runRetention() } : {}),
  });
  let observer: ObserverScheduler | undefined;
  if (store) {
    try {
      observer = new ObserverScheduler({
        stateDir,
        coordinator,
        outbox: store,
        // Scope/model/exclusion wiring arrives with T10 (config plumbing);
        // defaults here keep scheduling honest and visible.
        scope: "local",
        sessionId: "pending",
      });
    } catch (err) {
      observerError = `observer init failed: ${(err as Error).name}`;
    }
  }
  return { coordinator, observer, observerError, store };
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
