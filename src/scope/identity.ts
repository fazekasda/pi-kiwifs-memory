/**
 * T03: project identity and scope resolution.
 *
 * Policy (architecture.md §2 [P], §9, decisions.md #5/#12):
 * - Identity is the normalized Git remote: `host/repo` after stripping scheme,
 *   port, credentials and a trailing `.git`. Branches and worktrees do NOT
 *   change identity (a worktree of the same repo is the same project);
 *   branch/session lineage is Pi's concern (session/entry IDs), never a
 *   content hash.
 * - Non-Git directories and ambiguous (conflicting) remotes require an
 *   explicit `projectIdentity` override; resolution fails closed otherwise.
 * - The authorized scope set defaults to the own project plus `personal`;
 *   cross-project values enter only via explicit per-session opt-in.
 *   Cross-project reads are denied by default.
 */

export interface RemoteInput {
  /** Remote name → raw URL, from `git remote -v`-style input. */
  remotes: Record<string, string>;
}

export type IdentityResolution =
  | { ok: true; projectId: string; source: "git-remote" | "override" }
  | {
      ok: false;
      reason: "no-remotes" | "ambiguous-remotes" | "invalid-remotes";
      detail: string;
    };

/**
 * Normalizes a Git remote URL to `host/repo`. Throws FormatError-shaped
 * results via the returned union in `resolveProjectIdentity`; standalone use
 * throws on invalid input.
 */
export function normalizeGitRemote(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") throw new Error("empty remote URL");
  let rest = trimmed;
  // scp-like syntax: git@host:path.git
  const scp = /^([^@/]+)@([^:]+):(.+)$/.exec(rest);
  if (scp) {
    rest = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(rest);
  } catch {
    throw new Error(`unparseable remote URL: ${redactUrl(rest)}`);
  }
  if (
    parsed.protocol !== "ssh:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "git:"
  ) {
    throw new Error(`unsupported remote scheme: ${parsed.protocol}`);
  }
  let path = decodeURIComponent(parsed.pathname).replace(/\/+$/, "");
  path = path.replace(/\.git$/i, "");
  const segments = path.split("/").filter((s) => s !== "" && s !== "~");
  if (segments.length < 1) {
    throw new Error(`remote URL has no repository path: ${redactUrl(rest)}`);
  }
  // Identity is host plus the path's repository segments (owner included when
  // present); ports are stripped — the same host/repo on a mirrored port is
  // the same project.
  const repo = segments[segments.length - 1] as string;
  const owner =
    segments.length >= 2 ? segments[segments.length - 2] : undefined;
  const host = parsed.hostname.toLowerCase();
  return `${host}${owner ? `/${owner}` : ""}/${repo}`.toLowerCase();
}

/** Strips userinfo credentials before any error text can carry them. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/g, "//[redacted]@");
}

/**
 * Resolves the project identity from remotes, honoring an explicit override.
 * Fails closed on non-Git (no remotes) and ambiguous (conflicting normalized
 * remotes) inputs unless `override` is provided.
 */
export function resolveProjectIdentity(
  input: RemoteInput,
  override?: string,
): IdentityResolution {
  if (override !== undefined) {
    if (!/^[^\s]+\/[^\s]+$/.test(override)) {
      return {
        ok: false,
        reason: "invalid-remotes",
        detail: `explicit projectIdentity override must look like host[/group]/repo, got: ${override}`,
      };
    }
    return { ok: true, projectId: override.toLowerCase(), source: "override" };
  }
  const entries = Object.entries(input.remotes).filter(
    ([, v]) => typeof v === "string" && v.trim() !== "",
  );
  if (entries.length === 0) {
    return {
      ok: false,
      reason: "no-remotes",
      detail:
        "non-Git project: no git remotes found; set an explicit projectIdentity override",
    };
  }
  const normalized = new Map<string, string[]>();
  for (const [name, url] of entries) {
    try {
      const id = normalizeGitRemote(url);
      const list = normalized.get(id) ?? [];
      list.push(name);
      normalized.set(id, list);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid-remotes",
        detail: `remote "${name}": ${(err as Error).message}; set an explicit projectIdentity override`,
      };
    }
  }
  if (normalized.size > 1) {
    const shown = [...normalized.keys()].map((id) => id).join(", ");
    return {
      ok: false,
      reason: "ambiguous-remotes",
      detail: `conflicting remotes normalize to distinct identities (${shown}); set an explicit projectIdentity override`,
    };
  }
  const [projectId] = normalized.keys();
  return { ok: true, projectId: projectId as string, source: "git-remote" };
}

export type ScopeValue = `project/${string}` | "personal" | `cross/${string}`;

/** The record scope for the resolved project. */
export function projectScope(projectId: string): `project/${string}` {
  return `project/${projectId}`;
}

/**
 * The session's authorized scope set: own project + optional personal +
 * explicit cross-project opt-in values. Bounded by N ≤ 4 (§13 row 3) — the
 * set exceeding that bound fails closed (retrieval must not fan out wider).
 */
export function authorizedScopeSet(
  projectId: string,
  options: {
    allowPersonalGlobal: boolean;
    crossProjectOptIn: readonly string[];
  },
): { ok: true; scopes: ScopeValue[] } | { ok: false; reason: string } {
  const scopes: ScopeValue[] = [projectScope(projectId)];
  if (options.allowPersonalGlobal) scopes.push("personal");
  for (const value of options.crossProjectOptIn) {
    if (!value.startsWith("cross/")) {
      return {
        ok: false,
        reason: `cross-project opt-in values must start with "cross/", got: ${value}`,
      };
    }
    scopes.push(value as `cross/${string}`);
  }
  if (scopes.length > 4) {
    return {
      ok: false,
      reason: `authorized scope set exceeds the N≤4 fanout bound (got ${scopes.length}); deny explicitly before retrieving`,
    };
  }
  return { ok: true, scopes };
}

/** Scope gate used on every retrieved record's `$.scope` frontmatter value. */
export function scopeIsAuthorized(
  recordScope: string,
  authorized: readonly ScopeValue[],
): boolean {
  return (authorized as readonly string[]).includes(recordScope);
}
