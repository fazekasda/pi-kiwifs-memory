/**
 * Q06C3: focused command registration for the BOARD commands, extracted
 * verbatim from src/index.ts:
 *
 * - `kiwifs-board-cleanup` — MANUAL REMOTE board cleanup (Q05R3;
 *   architecture.md §8 F8, §13 row 13; decisions.md #14 — user-approved):
 *   preview → explicit confirm → guarded delete of THIS sender's own
 *   TTL-expired or locally-acked messages past the 30-day grace. DISTINCT
 *   from `kiwifs-board-gc`: that command keeps its local-only prune
 *   semantics and its `--yes` flag; `--yes` here is REFUSED so an old
 *   local-prune flag can never trigger a remote delete. Headless mode is a
 *   two-step flow: a plain preview run prints a confirmation token binding
 *   the EXACT candidate set; only `--confirm <token>` with a token matching
 *   a FRESH re-plan executes (never broadens after confirmation). TUI mode
 *   previews + ui.confirm binds the exact in-memory preview. Per-delete
 *   fresh rechecks, persist-before-side-effect opIds, visible skips,
 *   bounded deletes and the no-CAS/no-purge/no-secure-erasure disclosures
 *   are enforced by executeBoardCleanup (Q05R2) — this handler never
 *   deletes directly.
 * - `kiwifs-board-gc` — LOCAL-ONLY prune of acked/skipped entries past
 *   retention from the durable delivery state file. Undelivered entries are
 *   never touched; no backend call exists on this path. Explicit
 *   confirmation is REQUIRED: a UI confirm dialog, or the literal `--yes`
 *   argument in headless/RPC mode.
 *
 * Dependencies are EXPLICIT (the shared lazily-built runtime box and the
 * command config gate) — no module-level globals, no imports from index
 * (index imports this module; the direction is one-way). Consent policy,
 * remote-cleanup output and notification text are unchanged.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveFeatures } from "../config/schema.ts";
import { loadConfig } from "../config/loader.ts";
import { openConfiguredBackend, resolveStateDir } from "../runtime/session.ts";
import { BoardRepository } from "../board/repository.ts";
import { validateId, PathEscapeError } from "../domain/paths.ts";
import { planBoardCleanup } from "../board/cleanup.ts";
import { executeBoardCleanup } from "../board/cleanup-execute.ts";
import {
  BoardCleanupOpLog,
  cleanupPreviewToken,
  formatCleanupExecution,
  formatCleanupPreview,
  readDurableAckState,
  writePreviewRecord,
} from "./board-cleanup.ts";
import { errorName } from "./manual-ops.ts";
import {
  assertCommandRegistrationDeps,
  type CommandRegistrationDeps,
} from "./registration.ts";

/**
 * MANUAL REMOTE board cleanup: preview → explicit confirm → guarded delete
 * (see module doc for the full consent/output contract).
 */
export function registerBoardCleanupCommand(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract: fail closed at registration time if the required
  // shared dependencies are missing (a mis-wired composition must be
  // visible at startup, never discovered mid-command).
  assertCommandRegistrationDeps(deps, "registerBoardCleanupCommand");
  const { runtimeBox, configGate } = deps;

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
}

/** LOCAL-ONLY board delivery-state GC (explicit confirmation required). */
export function registerBoardGcCommand(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract: fail closed at registration time if the required
  // shared dependencies are missing.
  assertCommandRegistrationDeps(deps, "registerBoardGcCommand");
  const { runtimeBox } = deps;

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
}
