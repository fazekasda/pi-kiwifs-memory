/**
 * T18: runtime project-identity discovery from `git remote -v`
 * (architecture.md §2 [P]; the follow-up recorded across T07–T15).
 *
 * Closes the gap where the record scope only resolved via an explicit
 * `projectIdentity` override and observation/backup were held entirely for
 * Git projects. Discovery runs `git remote -v` in the session cwd, parses
 * the remote URL list and reuses the T03 normalization/fail-closed policy in
 * scope/identity.ts:
 * - zero remotes or conflicting normalized identities → NOT resolved
 *   (fail closed; the caller holds with a visible reason, exactly like an
 *   unset projectIdentity);
 * - the resolved value is only `host[/owner]/repo` — raw URLs (which may
 *   embed credentials) never leave this module in success output, and error
 *   text goes through the identity module's URL redaction.
 *
 * The command is bounded (5 s timeout) and synthetic-test friendly: callers
 * may inject a `run` function instead of spawning git.
 */

import { execFileSync } from "node:child_process";
import { resolveProjectIdentity } from "./identity.ts";

export interface DiscoveryOptions {
  cwd: string;
  /**
   * Test seam: produce `git remote -v`-shaped output. Defaults to spawning
   * `git remote -v` with a bounded timeout in `cwd`.
   */
  run?: (cwd: string) => string;
  /** Test seam: the process spawning failure is surfaced as fail-closed. */
  execFileSyncImpl?: typeof execFileSync;
}

export type DiscoveryResult =
  | { ok: true; projectId: string; source: "git-remote" }
  | {
      ok: false;
      reason:
        "no-remotes" | "ambiguous-remotes" | "invalid-remotes" | "unavailable";
      detail: string;
    };

/** Parses `git remote -v` output into a name → fetch-URL map. */
export function parseGitRemoteV(output: string): Record<string, string> {
  const remotes: Record<string, string> = {};
  for (const line of output.split("\n")) {
    // Lines look like: `origin\tgit@host:owner/repo.git (fetch)`.
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const [, name, url, kind] = m;
    // The fetch URL defines identity; push-only lines never contribute.
    if (kind === "fetch" && !(name in remotes)) remotes[name] = url;
  }
  return remotes;
}

const GIT_TIMEOUT_MS = 5_000;

function defaultRun(cwd: string): string {
  return execFileSync("git", ["remote", "-v"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
    // No env inheritance concerns: git only reads the repo config here.
    windowsHide: true,
  });
}

/**
 * Discovers the project identity for `cwd`. Never throws; every failure is
 * a fail-closed, sanitized detail (no raw URLs, no command output dumps).
 */
export function discoverProjectIdentity(
  options: DiscoveryOptions,
): DiscoveryResult {
  let output: string;
  try {
    output = options.run ? options.run(options.cwd) : defaultRun(options.cwd);
  } catch (err) {
    // Not a git repo, git missing, or timeout — all fail closed the same way.
    const code = (err as NodeJS.ErrnoException).code;
    const detail =
      code === "ENOENT"
        ? "git is not available"
        : code
          ? `git remote -v failed (${code})`
          : "git remote -v failed";
    return { ok: false, reason: "unavailable", detail };
  }
  const remotes = parseGitRemoteV(output);
  const res = resolveProjectIdentity({ remotes });
  if (res.ok) {
    return {
      ok: true,
      projectId: res.projectId,
      source: res.source === "override" ? "git-remote" : "git-remote",
    };
  }
  // The identity module's detail text is already credential-redacted.
  return { ok: false, reason: res.reason, detail: res.detail };
}
