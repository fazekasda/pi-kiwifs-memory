/**
 * Q06C3: focused command registration for the CONTROL/inspection commands,
 * extracted verbatim from src/index.ts:
 *
 * - `kiwifs-status` — sanitized status text from the shared status module
 *   (src/runtime/status.ts; Q06C1).
 * - `kiwifs-private-mode` — the private-mode toggle wired to the T18
 *   chunk-1 control surface (explicitly injected; the guarantees live in
 *   src/runtime/controls.ts). The config edit persists FIRST (atomic,
 *   validated); enabling then cancels pending retrieval (generation bump)
 *   so no in-flight evidence pack survives the flip. Live gates re-read
 *   config per boundary — no restart needed.
 * - `kiwifs-queue` — sanitized outbox stats + quarantined job fingerprints
 *   (seq/kind/attempts/name:code only — payloads are never shown).
 * - `kiwifs-erasure-report` — B6 disclosure: disclosure-only, zero I/O,
 *   deletes nothing.
 *
 * Dependencies are EXPLICIT: the private-mode command receives the
 * composition's control-surface factory; the queue command receives the
 * shared lazily-built runtime box. No module-level globals, no imports from
 * index (index imports this module; the direction is one-way).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfigLive } from "../privacy/live-gate.ts";
import type { RuntimeControlSurface } from "../runtime/controls.ts";
import { resolveStatusText } from "../runtime/status.ts";
import { erasureReportLines } from "./manual-ops.ts";
import {
  assertCommandRegistrationDeps,
  type CommandRegistrationDeps,
} from "./registration.ts";

/** Explicit dependencies for the private-mode toggle command. */
export interface PrivateModeCommandDeps {
  /** Control-surface factory for the command's session (lazy runtime). */
  controlSurface: (cwd: string) => RuntimeControlSurface;
}

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("kiwifs-status", {
    description: "Show KiwiFS memory extension status",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(resolveStatusText(), "info");
      }
    },
  });
}

export function registerPrivateModeCommand(
  pi: ExtensionAPI,
  deps: PrivateModeCommandDeps,
): void {
  // Composition contract: fail closed at registration time if the required
  // control-surface factory is missing — a private-mode toggle without a
  // control surface must never silently no-op (it would persist nothing and
  // cancel nothing).
  if (
    deps === undefined ||
    deps === null ||
    typeof deps.controlSurface !== "function"
  ) {
    throw new Error(
      "registerPrivateModeCommand: required controlSurface factory is missing — refusing to register (fail closed)",
    );
  }
  const { controlSurface } = deps;

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
      // Q07C: through the single live-config owner (fail-closed: an invalid
      // config reads as private for the status view too).
      const view = readConfigLive();
      if (mode === "status") {
        if (ctx.hasUI) {
          if (!view.ok || !view.config)
            ctx.ui.notify("config: INVALID", "error");
          else
            ctx.ui.notify(
              `private mode: ${view.config.privateMode ? "ON" : "OFF"}${
                view.config.privateMode
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
}

export function registerQueueCommand(
  pi: ExtensionAPI,
  deps: CommandRegistrationDeps,
): void {
  // Composition contract: fail closed at registration time if the required
  // shared dependencies are missing.
  assertCommandRegistrationDeps(deps, "registerQueueCommand");
  const { runtimeBox } = deps;

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
}

export function registerErasureReportCommand(pi: ExtensionAPI): void {
  // B6 erasure disclosure: disclosure-only, zero I/O, deletes nothing.
  pi.registerCommand("kiwifs-erasure-report", {
    description:
      "Show where KiwiFS record content is retained (B6 disclosure; nothing is deleted)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(erasureReportLines().join("\n"), "info");
    },
  });
}
