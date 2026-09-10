/**
 * Q06C3: focused command registration for BACKUP verification, extracted
 * verbatim from src/index.ts. T15: backup verification and approved
 * recovery path. Read-only against the backend (kiwi_read only); export is
 * non-destructive — it writes ONLY to an explicit new destination directory
 * and never overwrites existing sessions or paths (architecture.md §7;
 * restore-into-Pi is deferred, §13 row 20, and is not attempted here).
 *
 * No shared runtime/config-gate singleton is used here: the handler re-reads
 * config itself (its config gate differs from the command configGate — a
 * held verify is reported, not refused) and never touches the lazily-built
 * runtime. No imports from index (index imports this module; one-way).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/loader.ts";
import { resolveRecordScope } from "../runtime/session.ts";
import { openConfiguredBackend } from "../runtime/session.ts";
import { exportBackup, ExportRefusedError } from "../backup/verify.ts";
import { verifyRemoteBackup } from "../backup/recovery.ts";
import { validateProjectId } from "../domain/paths.ts";

export function registerBackupVerifyCommand(pi: ExtensionAPI): void {
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
}
