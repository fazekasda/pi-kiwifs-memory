/**
 * T05: backend path grammar and namespace isolation (architecture.md §2).
 *
 * Backend paths are built exclusively through these helpers. Untrusted
 * identifiers (obs/refl/proposal ids, session ids, channel names, msg ids)
 * MUST match the strict charset grammar `^[a-z0-9][a-z0-9-]{0,63}$` so that a
 * hostile id (`../x`, `%2e%2e`, empty, whitespace) can never escape its
 * namespace prefix.
 *
 * The project identity inside `scope/project/{id}` and
 * `backup/{project-id}/` comes from the T03 identity resolver (lowercase
 * host/repo) and may contain `/` and `.`; it is validated by a separate
 * rule that rejects path traversal and separator abuse instead of the ID
 * grammar.
 */

import { BackendError } from "../backend/errors.ts";

/** Strict grammar for untrusted, namespace-internal identifiers. */
export const ID_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Invalid or escaping identifier / path component. */
export class PathEscapeError extends BackendError {
  constructor(message: string) {
    super("validation", message);
    this.name = "PathEscapeError";
  }
}

/** Validates an untrusted identifier against the strict grammar. */
export function validateId(kind: string, id: string): string {
  if (typeof id !== "string" || !ID_GRAMMAR.test(id)) {
    throw new PathEscapeError(
      `${kind} id failed the strict path grammar (must match ^[a-z0-9][a-z0-9-]{0,63}$): ${safePreview(id)}`,
    );
  }
  return id;
}

/**
 * Validates a project identity used inside a backend path: rejects empty,
 * whitespace, backslashes, control chars, percent-encoding, and any `..`
 * segment (traversal). Lowercase `host[/owner]/repo` from T03 always passes.
 */
export function validateProjectId(projectId: string): string {
  if (
    typeof projectId !== "string" ||
    projectId === "" ||
    projectId !== projectId.toLowerCase() ||
    projectId !== projectId.trim() ||
    /[\s\\%\u0000-\u001f\u007f]/.test(projectId)
  ) {
    throw new PathEscapeError(
      `project identity is not path-safe: ${safePreview(projectId)}`,
    );
  }
  const segments = projectId.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new PathEscapeError(
      `project identity contains an empty, "." or ".." path segment: ${safePreview(projectId)}`,
    );
  }
  return projectId;
}

function safePreview(value: unknown): string {
  const s = String(value);
  const shown = s.length > 40 ? `${s.slice(0, 40)}…` : s;
  return JSON.stringify(shown);
}

const RECORD_KIND_DIR: Record<string, string> = {
  observation: "observations",
  reflection: "reflections",
  proposal: "merge-proposals",
};

/** Deterministic record path: `{scope}/memory/{kind-dir}/[{yyyy}/{mm}/]{id}.md`. */
export function memoryRecordPath(
  scope: string,
  type: "observation" | "reflection" | "proposal",
  id: string,
  created?: { getUTCFullYear(): number; getUTCMonth(): number },
): string {
  validateId(type, id);
  if (scope !== "personal" && !scope.startsWith("project/")) {
    throw new PathEscapeError(`record scope is not an owner scope: ${scope}`);
  }
  if (scope.startsWith("project/")) {
    validateProjectId(scope.slice("project/".length));
  }
  const dir = RECORD_KIND_DIR[type];
  if (type === "proposal" || created === undefined) {
    return `${scope}/memory/${dir}/${id}.md`;
  }
  // UTC bucketing: the path must be identical regardless of the process
  // timezone, so that a given record always derives the same deterministic
  // path (read-before-write idempotency, stable month buckets).
  const yyyy = String(created.getUTCFullYear()).padStart(4, "0");
  const mm = String(created.getUTCMonth() + 1).padStart(2, "0");
  return `${scope}/memory/${dir}/${yyyy}/${mm}/${id}.md`;
}

/** `backup/{project-id}/{session-id}/manifest.md`. */
export function backupManifestPath(
  projectId: string,
  sessionId: string,
): string {
  validateProjectId(projectId);
  validateId("session", sessionId);
  return `backup/${projectId}/${sessionId}/manifest.md`;
}

/** `backup/{project-id}/{session-id}/{seq:06d}.md`. */
export function backupChunkPath(
  projectId: string,
  sessionId: string,
  seq: number,
): string {
  validateProjectId(projectId);
  validateId("session", sessionId);
  if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) {
    throw new PathEscapeError(`backup chunk seq out of range: ${seq}`);
  }
  return `backup/${projectId}/${sessionId}/${String(seq).padStart(6, "0")}.md`;
}

/** `board/{channel}/{msg_id}.md`. */
export function boardMessagePath(channel: string, msgId: string): string {
  validateId("channel", channel);
  validateId("msg_id", msgId);
  return `board/${channel}/${msgId}.md`;
}

/**
 * Namespace containment check used by the guard pipeline (step 4): the hit
 * path must lie inside the scope's `memory/` namespace. Rejects `..` segments
 * and exact-prefix boundary abuse (`memory-evil/` does not pass `memory/`).
 */
export function pathWithinMemoryNamespace(
  path: string,
  scope: string,
): boolean {
  if (scope !== "personal" && !scope.startsWith("project/")) return false;
  const prefix = `${scope}/memory/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return !rest.split("/").includes("..");
}

/** Same containment rule for board paths under `board/{channel}/`. */
export function pathWithinBoardChannel(path: string, channel: string): boolean {
  validateId("channel", channel);
  const prefix = `board/${channel}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return !rest.split("/").includes("..");
}

/** Same containment rule for backup trees under `backup/{project-id}/`. */
export function pathWithinBackupTree(path: string, projectId: string): boolean {
  validateProjectId(projectId);
  const prefix = `backup/${projectId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return !rest.split("/").includes("..");
}
