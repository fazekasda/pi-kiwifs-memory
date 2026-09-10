import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readConfigLive } from "./privacy/live-gate.ts";
import type { AuthRef } from "./config/schema.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";
import { effectiveFeatures, type MemoryConfig } from "./config/schema.ts";
import type {
  AcceptedRecord,
  createModelReflector,
} from "./observation/reflection.ts";
import { ProposalOpLog } from "./observation/proposals.ts";
import { StateSchemaError } from "./pi/coordinator.ts";
import { EvidenceInjector } from "./inject/injector.ts";
import {
  buildMemoryReadTool,
  buildMemorySearchTool,
  type RecallRuntime,
  type RecallToolsDeps,
} from "./inject/tools.ts";
import {
  buildBoardReadTool,
  buildBoardListTool,
  buildBoardSendTool,
  buildBoardInboxTool,
  buildBoardAckTool,
  type BoardRuntime,
  type BoardToolsDeps,
} from "./board/tools.ts";
import {
  buildRuntimeControlSurface,
  type RuntimeControlSurface,
} from "./runtime/controls.ts";
import { createRedactor } from "./privacy/redaction.ts";
// Q06C2: observation/proposal/forget/personal-note command registration
// lives in src/commands/registration.ts (explicit runtime/config-gate deps,
// one-way index → commands direction). Replaced here in the same order.
import {
  registerForgetCommands,
  registerObservationCommands,
  registerPersonalNoteCommand,
  registerProposalCommands,
} from "./commands/registration.ts";
import { DurableOutbox } from "./outbox/store.ts";
import { toSourceViews } from "./observation/scheduler.ts";
// Q06C3: board (cleanup/gc), backup-verify and control (status/private-mode/
// queue/erasure-report) command registration lives in focused modules under
// src/commands/ with explicit deps; index is the lifecycle/composition
// entrypoint and passes the SAME shared runtime box / config gate (never
// recreating singleton dependencies).
import {
  registerBoardCleanupCommand,
  registerBoardGcCommand,
} from "./commands/board-commands.ts";
import { registerBackupVerifyCommand } from "./commands/backup-commands.ts";
import {
  registerErasureReportCommand,
  registerPrivateModeCommand,
  registerQueueCommand,
  registerStatusCommand,
} from "./commands/control-commands.ts";

// Q06C1: status probe aggregation / runtime-status ownership lives in
// src/runtime/status.ts (STATUS_MESSAGE, computeOverallState,
// resolveStatusText, the `set*Probe` inspection seams). Re-exported here so
// the public API (and the tests that exercise it through index) remain
// unchanged. The runtime-derived probes are pushed INTO that module via
// `wireRuntimeStatusProbes` in registerSessionHandlers (explicit dependency:
// index → status, never the reverse).
export {
  computeOverallState,
  resolveStatusText,
  setBackupNoteProbe,
  setBoardNoteProbe,
  setCapturePausedProbe,
  setCoordinatorErrorProbe,
  setObserverErrorProbe,
  setQueueNoteProbe,
  setQueueQuarantinedProbe,
  setRetrievalNoteProbe,
  setTokenizerDegradedProbe,
  setTokenizerNoteProbe,
  STATUS_MESSAGE,
} from "./runtime/status.ts";
import {
  resolveStatusText,
  wireRuntimeStatusProbes,
} from "./runtime/status.ts";

// Q06B1: session runtime construction lives in src/runtime/session.ts
// (SessionRuntime type, buildSessionRuntime, resolveStateDir,
// openConfiguredBackend, crossOptInToScopes). Re-exported here so the public
// API (and the tests that exercise the shipped factory through index)
// remain unchanged. Q06C1: `setTokenizerNoteSink` was an orphan after the
// session extraction — exported, but registered by nobody — and is
// deliberately removed: the tokenizer note is owned by the runtime instance
// and surfaced through the status probe (src/runtime/status.ts), which reads
// the CURRENT runtime, so a stale session's note can never leak.
export {
  buildSessionRuntime,
  crossOptInToScopes,
  openConfiguredBackend,
  resolveStateDir,
  type SessionRuntime,
} from "./runtime/session.ts";
import {
  buildSessionRuntime,
  openConfiguredBackend,
  resolveStateDir,
} from "./runtime/session.ts";
import type { SessionRuntime } from "./runtime/session.ts";

// Q06C3: the T18 control-surface factory lives in src/runtime/controls.ts
// (next to the guarantees it composes); re-exported so the public API and
// the tests exercising it through index are unchanged.
export { buildRuntimeControlSurface } from "./runtime/controls.ts";

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
  // Q06C1: runtime-derived status probes are pushed explicitly into the
  // status module (src/runtime/status.ts) — no shared module-globals.
  wireRuntimeStatusProbes({
    coordinatorError: () => runtimeError,
    observerError: () => {
      if (runtimeError) return runtimeError;
      return runtime?.observerError;
    },
    retrievalNote: () => {
      if (runtimeError) return runtimeError;
      if (retrievalDropNote) return retrievalDropNote;
      if (runtime?.retrievalHeldReason) return runtime.retrievalHeldReason;
      return runtime?.retrieval?.lastDegradedNote;
    },
    tokenizerNote: () => runtime?.tokenizerNote,
    tokenizerDegraded: () => runtime?.tokenizerDegraded ?? false,
    backupNote: () => {
      if (runtime?.backupHeldReason) return runtime.backupHeldReason;
      const lines = runtime?.backup?.pendingStatus() ?? [];
      return lines.length > 0 ? lines.join("; ") : undefined;
    },
    boardNote: () => {
      if (runtime?.deliveryHeldReason) return runtime.deliveryHeldReason;
      const d = runtime?.delivery;
      if (!d) return undefined;
      const s = d.statusSnapshot();
      const err = d.lastErrorFingerprint();
      if (s.holdReason) return `HELD — ${s.holdReason}`;
      return `state=${s.runState} unread=${s.unread} consumer=${s.consumerId}${
        err ? ` lastError=${err}` : ""
      }`;
    },
    // T18: sanitized queue summary for status + overall-state attribution.
    queueNote: () => {
      const s = runtime?.store?.stats;
      if (!s) return undefined;
      return `outbox: pending=${s.pending} quarantined=${s.quarantined}${
        s.paused ? " capture=PAUSED (coverage gap)" : ""
      }`;
    },
    queueQuarantined: () => runtime?.store?.stats.quarantined ?? 0,
    // T18 review fix: capture paused (coverage gap) is a degraded condition.
    capturePaused: () => runtime?.store?.stats.paused ?? false,
    // Q04b: sanitized audit-sink health (content-free: counts + errno class
    // only — never paths, identifiers, or error text). Degraded-only: a
    // healthy sink is silent, like the other status probes.
    auditNote: () => {
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
    },
  });

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
  // Q07B1: deps resolve through the single live-config owner (readConfigLive)
  // — one per-call read classifies validity/enablement; the per-check
  // private-mode predicate is the owner's fail-closed read, so a config that
  // turns invalid/unreadable mid-call fails closed instead of using a permit
  // captured before the flip.
  const recallDeps = (): RecallToolsDeps | undefined => {
    const view = readConfigLive();
    if (!view.ok || !view.config) return undefined;
    const config = view.config;
    const rt = runtime;
    return {
      getRuntime: getRecallRuntime,
      getHeldReason,
      privateMode: () => readConfigLive().privateMode,
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
    // Q07B1: same single-owner read as the recall tools (see recallDeps).
    const view = readConfigLive();
    if (!view.ok || !view.config) return undefined;
    const config = view.config;
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
      privateMode: () => readConfigLive().privateMode,
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
    // Q06B2 (ownership): release the durable outbox lock and the runtime
    // itself. The runtime is SESSION-scoped: `session_shutdown` tears down
    // every owned resource and the next session event rebuilds a fresh
    // runtime — a disposed gate/audit lock/consumer lock must never leak
    // into a later session in the same process (fail-closed would otherwise
    // hold the next session's delivery permanently). Durable state (outbox
    // journal, coordinator state, board cursors, audit log) is retained on
    // disk; nothing pending is dropped.
    try {
      runtime?.store?.close();
    } catch {
      /* best effort; already-closed stores are harmless */
    }
    runtime = undefined;
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

  /** Command-side gates: config must be valid, enabled and not private.
   *  Q07B1: classified through the single live-config owner (readConfigLive)
   *  — one read per command; the failing notices are unchanged. */
  const configGate = ():
    | { ok: false; notice: string }
    | { ok: true; config: MemoryConfig; configFile: string | undefined } => {
    const view = readConfigLive();
    if (!view.ok || !view.config)
      return { ok: false, notice: "config: INVALID" };
    if (!view.enabled) return { ok: false, notice: "extension disabled" };
    if (view.privateMode)
      return {
        ok: false,
        notice:
          "private mode active — all domains hold (zero reads/writes); use /kiwifs-private-mode off to resume",
      };
    return { ok: true, config: view.config, configFile: view.file };
  };

  /** T18: control surface for the command's session (lazy runtime). */
  const controlSurface = (cwd: string): RuntimeControlSurface =>
    buildRuntimeControlSurface({
      // Q07B1: resolved path via the single live-config owner.
      configFile: readConfigLive().file,
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

  // Q06C3: control/inspection + backup + board commands are registered by
  // focused modules under src/commands/ (explicit deps, registration order
  // preserved; index stays the lifecycle/composition entrypoint).
  registerStatusCommand(pi);

  registerBackupVerifyCommand(pi);

  // ---- T18 chunk 2: command wiring (all headless/RPC safe) --------------

  registerPrivateModeCommand(pi, { controlSurface });

  // Q06C2: observation, proposal, forget and personal-note commands are
  // registered by src/commands/registration.ts with the SAME shared runtime
  // box and config gate (explicit deps; registration order preserved).
  const commandDeps = { runtimeBox, configGate };
  registerObservationCommands(pi, commandDeps);
  registerProposalCommands(pi, commandDeps);
  registerForgetCommands(pi, commandDeps);
  registerPersonalNoteCommand(pi, commandDeps);

  // Q06C3: board (cleanup/gc) and queue commands registered by focused
  // modules with the SAME shared runtime box / config gate (no duplicated
  // singleton dependencies; registration order preserved).
  registerBoardCleanupCommand(pi, commandDeps);
  registerBoardGcCommand(pi, commandDeps);
  registerQueueCommand(pi, commandDeps);
  registerErasureReportCommand(pi);
}
