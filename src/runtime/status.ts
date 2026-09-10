/**
 * Q06C1: status probe aggregation and runtime-status ownership, extracted
 * from src/index.ts (moved verbatim where possible).
 *
 * This module OWNS the sanitized status surface:
 * - the `last*` probe slots that translate the current SessionRuntime's
 *   structured state (holds, degradations, queue/audit health) into
 *   fail-visible status text,
 * - the test/inspection hooks (`set*Probe`) that deliberately preserve the
 *   pre-existing seams (migrated with the production code, not orphaned),
 * - `computeOverallState` (disabled > private > degraded > healthy) and
 *   `resolveStatusText` (secret-free status rendering).
 *
 * Dependencies are explicit and acyclic: this module imports config +
 * observation helpers only. It never imports src/index.ts or
 * src/runtime/session.ts; the runtime-derived probes are pushed IN through
 * `wireRuntimeStatusProbes` by `registerSessionHandlers` (src/index.ts), so
 * the dependency direction is index → status, never the reverse.
 *
 * Q06C1 sink-orphan fix: since the Q06B2 extraction, the tokenizer note is
 * OWNED by the per-session runtime instance (src/runtime/session.ts mutates
 * `rt.tokenizerNote` after the async module load) and the status probe reads
 * the CURRENT runtime — a superseded session's late note cannot surface.
 * The former `setTokenizerNoteSink` hook in session.ts had no registrar
 * after the extraction (an orphan); it was deliberately removed rather than
 * registered, and the runtime-owned probe below is the single status path.
 */
import { loadConfig } from "../config/loader.ts";
import { resolvedStatusLines, statusIsSecretFree } from "../config/status.ts";
import { effectiveFeatures } from "../config/schema.ts";
import { resolveAuthSecret } from "../observation/model.ts";

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

/**
 * Q06C1: explicit runtime-status wiring. `registerSessionHandlers`
 * (src/index.ts) pushes the runtime-derived probes IN — this module never
 * reaches into index state. Each slot here is the same value the runtime
 * owns; the `set*Probe` test hooks may replace an individual slot afterwards
 * (same precedence as before the extraction).
 */
export interface RuntimeStatusProbes {
  coordinatorError: () => string | undefined;
  observerError: () => string | undefined;
  retrievalNote: () => string | undefined;
  tokenizerNote: () => string | undefined;
  tokenizerDegraded: () => boolean;
  backupNote: () => string | undefined;
  boardNote: () => string | undefined;
  queueNote: () => string | undefined;
  queueQuarantined: () => number;
  capturePaused: () => boolean;
  auditNote: () => string | undefined;
}

export function wireRuntimeStatusProbes(p: RuntimeStatusProbes): void {
  lastCoordinatorError = p.coordinatorError;
  lastObserverError = p.observerError;
  lastRetrievalNote = p.retrievalNote;
  lastTokenizerNote = p.tokenizerNote;
  lastTokenizerDegraded = p.tokenizerDegraded;
  lastBackupNote = p.backupNote;
  lastBoardNote = p.boardNote;
  lastQueueNote = p.queueNote;
  lastQueueQuarantined = p.queueQuarantined;
  lastCapturePaused = p.capturePaused;
  lastAuditNote = p.auditNote;
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
