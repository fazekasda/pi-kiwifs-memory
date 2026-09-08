import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";
import { SessionCoordinator, StateSchemaError } from "./pi/coordinator.ts";

export const STATUS_MESSAGE =
  "KiwiFS memory extension loaded. Memory storage is not implemented yet.";

/** Last coordinator init error, surfaced via status (fail-visible). */
let lastCoordinatorError: (() => string | undefined) | undefined;

/** Test/inspection hook for the coordinator error probe. */
export function setCoordinatorErrorProbe(
  probe: (() => string | undefined) | undefined,
): void {
  lastCoordinatorError = probe;
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
 * T08: session coordinator hook wiring. Registers Pi lifecycle handlers at
 * the boundaries verified in docs/research/mcp-contracts.md §6. Handlers are
 * reentrant and never require TUI-only APIs (headless/RPC safe). Coordinator
 * construction failures disable lifecycle tracking visibly instead of
 * breaking extension startup.
 */
export function registerSessionHandlers(
  pi: ExtensionAPI,
  createCoordinator: (cwd: string) => SessionCoordinator,
): void {
  let coordinator: SessionCoordinator | undefined;
  let coordinatorError: string | undefined;
  lastCoordinatorError = () => coordinatorError;

  const get = (ctx: ExtensionContext): SessionCoordinator | undefined => {
    if (coordinator) return coordinator;
    if (coordinatorError) return undefined;
    try {
      coordinator = createCoordinator(ctx.cwd);
    } catch (err) {
      coordinatorError =
        err instanceof StateSchemaError
          ? err.message
          : `session coordinator init failed: ${(err as Error).name}`;
    }
    return coordinator;
  };

  // No-UI access: handlers only read ctx.sessionManager / ctx.cwd.
  pi.on("session_start", async (event, ctx) => {
    get(ctx)?.onSessionStart(ctx, event);
  });
  pi.on("session_before_fork", async () => {
    // No ctx needed: fork snapshot point; generation re-mints at session_start.
    coordinator?.onBeforeFork();
  });
  pi.on("session_before_switch", async () => {
    coordinator?.onBeforeSwitch();
  });
  pi.on("session_before_tree", async (event) => {
    coordinator?.onBeforeTree(event.preparation, event.signal);
  });
  pi.on("session_tree", async (event, ctx) => {
    get(ctx)?.onTree(ctx, event.oldLeafId, event.newLeafId);
  });
  pi.on("session_shutdown", async () => {
    coordinator?.onShutdown();
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

  registerSessionHandlers(pi, (cwd) => {
    // Outbox tick/retention hooks arrive with T09 (observation scheduling);
    // until then the coordinator tracks lifecycle without a timer.
    return new SessionCoordinator({ stateDir: resolveStateDir(cwd) });
  });
}
