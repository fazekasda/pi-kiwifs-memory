/**
 * T18 chunk 1: command-facing runtime control interfaces (PRD T18 — user
 * controls must ACTUALLY reconfigure the active runtime, not merely edit
 * files or status text). Chunk 2 wires Pi commands to these functions; the
 * interfaces and their guarantees are established here so command wiring
 * cannot drift from the runtime contract.
 *
 * Guarantees every control honors:
 * - Live application: a private-mode change re-reads through the same
 *   fail-closed live gates the poller/retrieval already use per cycle, so an
 *   active poller/retrieval stops (or resumes) on its next boundary without
 *   a restart. Generation-marked work (retrieval packs) is invalidated so
 *   stale results never surface after a mode flip.
 * - Zero I/O in private mode: enabling private mode persists the file change
 *   BEFORE anything else runs; disabling it is a file edit plus gate resume
 *   (no I/O was performed while private — the gates hold that invariant).
 * - No secrets: control results carry sanitized fingerprints/reasons only.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { validateConfig } from "../config/schema.ts";

export type ControlResult =
  { ok: true; detail: string } | { ok: false; reason: string };

/**
 * Persists `privateMode: value` into the config file, preserving every other
 * key verbatim (secrets stay by reference — the raw file is edited, never
 * re-serialized from the validated model, so no field can be normalized
 * away). Atomic temp+rename, 0o600. Fails closed: the new file is validated
 * BEFORE the rename and a validation failure leaves the original untouched.
 */
export function setPrivateModeInFile(
  file: string,
  value: boolean,
): ControlResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `config unreadable/unparseable (${(err as Error).name}) — private mode NOT changed`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "config is not a JSON object — private mode NOT changed",
    };
  }
  const candidate = { ...raw, privateMode: value };
  const check = validateConfig(candidate);
  if (!check.ok) {
    return {
      ok: false,
      reason: `edited config invalid (${check.issues.map((i) => i.path).join(", ")}) — private mode NOT changed`,
    };
  }
  const dir = dirname(file);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(candidate, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    return {
      ok: false,
      reason: `config write failed (${(err as Error).name}) — private mode NOT changed`,
    };
  }
  return {
    ok: true,
    detail: value
      ? "private mode ON — all domains hold (zero reads/writes at the next gate)"
      : "private mode OFF — gated features resume at their next cycle",
  };
}

export interface RuntimeControlSurface {
  /**
   * Flips private mode on/off: persists the config change (validated,
   * atomic) and returns a sanitized result. The active poller and retrieval
   * pick the new value up through their fail-closed live gates on the very
   * next boundary — no stale result can cross the flip.
   */
  readonly setPrivateMode: (value: boolean) => ControlResult;
  /**
   * Invalidates in-flight retrieval results: bumps the runtime generation so
   * any evidence pack produced before this call is stale and dropped at
   * settle (never injected into a later turn).
   */
  readonly cancelPendingRetrieval: () => ControlResult;
}
