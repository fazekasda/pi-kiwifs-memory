/**
 * Q06C2: focused command registration for the observation, proposal,
 * forget/forget-undo and personal-note commands, extracted verbatim from
 * src/index.ts. Dependencies are EXPLICIT: every registration function
 * receives the shared lazily-built runtime box and the command config gate —
 * no module-level globals, no imports from index (index imports this module;
 * the direction is one-way). Handler semantics, confirmation policy, live
 * guards and notification text are unchanged; the board/backup/status/queue
 * command groups remain in index for now (Q06C2 scope boundary).
 */
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../config/schema.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { resolveStateDir } from "../runtime/session.ts";
import { StaleProposalError } from "../observation/proposals.ts";
import { DurableOutbox, OutboxError } from "../outbox/store.ts";
import { FileAuditStore } from "../privacy/audit-store.ts";
import type { AuditSinkLike } from "../privacy/audit.ts";
import { redactText } from "../privacy/redaction.ts";
import {
  ExplicitPersonalInputError,
  buildExplicitPersonalEnqueue,
} from "./personal-note.ts";
import {
  ManualOpLog,
  createManualOps,
  errorName,
  forgetMemoryPath,
  unforgetMemoryPath,
} from "./manual-ops.ts";

/** Structural mirror of index's RuntimeBox (no import from index: no cycles). */
export interface CommandRuntimeBox {
  /** Lazily-built per-session runtime (undefined until built or init failed). */
  getRuntime: (cwd: string) => SessionRuntime | undefined;
  /** Sanitized init-failure reason, when runtime construction failed. */
  getRuntimeError: () => string | undefined;
}

/** Command-side config gate result (mirrors index's configGate shape). */
export type CommandConfigGateResult =
  | { ok: false; notice: string }
  | { ok: true; config: MemoryConfig; configFile: string | undefined };

/** Explicit shared dependencies for the command registration functions. */
export interface CommandRegistrationDeps {
  runtimeBox: CommandRuntimeBox;
  configGate: () => CommandConfigGateResult;
}

/**
 * Composition contract (Q06C3): every command registration function FAILS
 * CLOSED at composition time when its required shared dependencies are
 * missing — a mis-wired composition must be visible at extension startup,
 * never discovered mid-command as a silent no-op.
 */
export function assertCommandRegistrationDeps(
  deps: CommandRegistrationDeps,
  label: string,
): void {
  if (deps === undefined || deps === null) {
    throw new Error(
      `${label}: required registration dependencies are missing — refusing to register (fail closed)`,
    );
  }
  if (
    typeof deps.runtimeBox?.getRuntime !== "function" ||
    typeof deps.runtimeBox?.getRuntimeError !== "function" ||
    typeof deps.configGate !== "function"
  ) {
    throw new Error(
      `${label}: runtimeBox.getRuntime/getRuntimeError and configGate must be functions — refusing to register (fail closed)`,
    );
  }
}

/**
 * Manual extraction trigger (same pipeline as the automatic settle path).
 */
export function registerObservationCommands(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract (Q06C3): fail closed on missing deps.
  assertCommandRegistrationDeps(deps, "registerObservationCommands");
  const { runtimeBox, configGate } = deps;

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
}

/**
 * Proposal lifecycle commands: approve / reject / undo — verified
 * transitions via the T11 lifecycle (fresh reads, read-back verification,
 * serialized locally). Stale states fail visibly, never silently.
 */
export function registerProposalCommands(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract (Q06C3): fail closed on missing deps.
  assertCommandRegistrationDeps(deps, "registerProposalCommands");
  const { runtimeBox, configGate } = deps;

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
}

/**
 * Reversible logical forget commands (B6: nothing is deleted; body
 * preserved). UI sessions require an explicit confirm; headless/RPC runs
 * act on the explicit args (documented). Tombstone cache refresh + cached
 * evidence pack drop follow every successful forget; restore is
 * read-back-verified with provenance.
 */
export function registerForgetCommands(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract (Q06C3): fail closed on missing deps.
  assertCommandRegistrationDeps(deps, "registerForgetCommands");
  const { runtimeBox, configGate } = deps;

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
}

/**
 * Q05P2: explicit personal note — the ONLY sanctioned personal-scope
 * write surface (docs/decisions.md #13, user-approved). A user command,
 * never an automatic capture/reflection/backup path and never a tool the
 * model can call: nothing promotes project content and no model call is
 * made by saving. UI sessions confirm via a preview dialog of the
 * REDACTED statement; headless/RPC requires the literal --yes token.
 * Redaction happens BEFORE the confirm preview and before enqueue; the
 * job reuses the durable outbox (opId persisted before any side effect).
 */
export function registerPersonalNoteCommand(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract (Q06C3): fail closed on missing deps.
  assertCommandRegistrationDeps(deps, "registerPersonalNoteCommand");
  const { runtimeBox, configGate } = deps;

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
}
