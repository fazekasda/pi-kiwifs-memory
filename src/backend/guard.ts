/**
 * T04: the fail-closed guard pipeline applied per candidate record before
 * any injection or use (mcp-contracts.md §8, architecture.md §3.1, B3):
 *
 *   1. fresh kiwi_read of the hit (404/missing → reject)
 *   2. status check — memory_status absent or "active" only
 *   3. scope check — $.scope ∈ session's authorized scope set (the ONLY gate
 *      on hybrid/brief legs, which carry no scope parameter)
 *   4. path-prefix check — within the scope's memory/ namespace
 *   5. privacy redaction of the content (T06 rules from src/privacy/redaction.ts
 *      via `createRedactor()`; callers may override with `deps.redact`.
 *      `identityRedactor` is an explicit test-only opt-out — never a
 *      production default)
 *
 * The local tombstone cache (superseded paths) is ADVISORY pre-filtering
 * only: a cache miss never permits injection — the read-back is the gate.
 */

import { createRedactor } from "../privacy/redaction.ts";
import { parseFrontmatter } from "./parse.ts";
import type { ScoredHit } from "./parse.ts";
import type { KiwiFSAdapter } from "./adapter.ts";

export type Redactor = (
  content: string,
) => { ok: true; content: string } | { ok: false; reason: string };

/**
 * No-op redactor: TEST-ONLY opt-out for suites that explicitly disable the
 * privacy gate. Production callers must never pass this as `deps.redact`.
 */
export const identityRedactor: Redactor = (content) => ({ ok: true, content });

export type GuardResult =
  | {
      ok: true;
      path: string;
      scope: string;
      body: string;
      etag?: string;
      frontmatter: Record<string, string>;
    }
  | {
      ok: false;
      step: "read-back" | "status" | "scope" | "path-prefix" | "redaction";
      reason: string;
    };

export type CacheRejection = { ok: false; step: "status"; reason: string };

export interface TombstoneCache {
  /** Advisory: true when the path is locally known to be superseded. */
  isAdvisoryTombstoned(path: string): boolean;
}

/** Advisory tombstone cache over kiwi_query_meta (§13 row 7 defaults). */
export class QueryMetaTombstoneCache implements TombstoneCache {
  private readonly adapter: KiwiFSAdapter;
  private readonly scopeValues: string[];
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private paths = new Set<string>();
  private fetchedAt = 0;

  constructor(
    adapter: KiwiFSAdapter,
    scopeValues: string[],
    ttlMs = 5 * 60 * 1000,
    now: () => number = () => Date.now(),
  ) {
    this.adapter = adapter;
    this.scopeValues = scopeValues;
    this.ttlMs = ttlMs;
    this.nowFn = now;
  }

  /** Refresh from the backend; advisory, failures leave the cache unchanged. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const fresh = new Set<string>();
    for (const scope of this.scopeValues) {
      const res = await this.adapter.queryMeta(
        { memory_status: "superseded" },
        { signal },
      );
      void scope; // query_meta has no scope param; results are post-filtered by guard step 3
      for (const m of res.text.matchAll(/^path:\s*(\S+)$/gm)) {
        fresh.add(m[1] as string);
      }
    }
    this.paths = fresh;
    this.fetchedAt = this.nowFn();
  }

  isAdvisoryTombstoned(path: string): boolean {
    if (this.nowFn() - this.fetchedAt > this.ttlMs) return false; // stale → advisory miss
    return this.paths.has(path);
  }
}

export interface GuardDeps {
  adapter: KiwiFSAdapter;
  /** Authorized scope set (e.g. ["project/demo-proj", "personal"]). */
  authorizedScopes: string[];
  redact?: Redactor;
  tombstoneCache?: TombstoneCache;
}

export type { ScoredHit };

/**
 * Runs the full 5-step pipeline for one candidate path. Every step fails
 * closed; the tombstone cache is consulted only as an advisory shortcut and
 * its emptiness/staleness can never permit a record through.
 */
export async function guardCandidate(
  path: string,
  deps: GuardDeps,
  signal?: AbortSignal,
): Promise<GuardResult> {
  // Step 1 — fresh read-back (advisory tombstone pre-filter never substitutes).
  const read = await deps.adapter.read(path, { signal });
  if (read.state !== "ok" || read.content === undefined) {
    return {
      ok: false,
      step: "read-back",
      reason: "read-back failed or missing",
    };
  }
  // Step 2 — status: absent or active only (superseded body still exists).
  const status = read.frontmatter["memory_status"];
  if (status !== undefined && status !== "active") {
    return {
      ok: false,
      step: "status",
      reason: `memory_status '${status}' is not active`,
    };
  }
  // Step 3 — scope: the only gate on hybrid/brief legs.
  const scope = read.frontmatter["scope"];
  if (scope === undefined || !deps.authorizedScopes.includes(scope)) {
    return {
      ok: false,
      step: "scope",
      reason: "scope missing or unauthorized",
    };
  }
  // Step 4 — path prefix inside the scope's memory/ namespace.
  if (!path.startsWith(`${scope}/memory/`)) {
    return {
      ok: false,
      step: "path-prefix",
      reason: "path outside the scope memory/ namespace",
    };
  }
  // Step 5 — privacy redaction (fail closed on classification failure).
  // Fail safe default: omitting `deps.redact` enables the real T06 redactor,
  // so a caller forgetting the override cannot ship unredacted content.
  const redact = deps.redact ?? createRedactor();
  const redacted = redact(read.body);
  if (!redacted.ok) {
    return { ok: false, step: "redaction", reason: redacted.reason };
  }
  return {
    ok: true,
    path,
    scope,
    body: redacted.content,
    ...(read.etag !== undefined ? { etag: read.etag } : {}),
    frontmatter: read.frontmatter,
  };
}

/**
 * Convenience pre-filter: true when the advisory cache marks the path
 * superseded. A false return proves nothing — always run guardCandidate.
 */
export function advisoryPreFilter(
  path: string,
  cache: TombstoneCache | undefined,
): boolean {
  return cache?.isAdvisoryTombstoned(path) ?? false;
}

const MIN_EVIDENCE_FRACTION = 0.25; // §13 row 4 default

/**
 * Brief scope gate (fixture 5a): every brief page goes through the guard
 * pipeline (brief has no scope parameter). If the kept pack falls below the
 * minimum-evidence threshold, the pack is rebuilt from scoped search hits —
 * each of which is guarded as well. Brief content never passes unverified.
 */
export async function buildBriefEvidence(
  briefSections: { path: string; body: string }[],
  scopedSearchHits: ScoredHit[],
  deps: GuardDeps,
  opts: { maxPackChars: number; signal?: AbortSignal },
): Promise<{
  kept: { path: string; body: string }[];
  dropped: { path: string; step: string }[];
  rebuilt: boolean;
}> {
  const kept: { path: string; body: string }[] = [];
  const dropped: { path: string; step: string }[] = [];
  let chars = 0;
  for (const section of briefSections) {
    const guarded = await guardCandidate(section.path, deps, opts.signal);
    if (!guarded.ok) {
      dropped.push({ path: section.path, step: guarded.step });
      continue;
    }
    if (chars + guarded.body.length > opts.maxPackChars) break;
    kept.push({ path: guarded.path, body: guarded.body });
    chars += guarded.body.length;
  }
  if (chars >= opts.maxPackChars * MIN_EVIDENCE_FRACTION) {
    return { kept, dropped, rebuilt: false };
  }
  // Fallback rebuild from scoped search results (all guarded).
  const rebuilt: { path: string; body: string }[] = [];
  let rebuiltChars = 0;
  for (const hit of scopedSearchHits) {
    const guarded = await guardCandidate(hit.path, deps, opts.signal);
    if (!guarded.ok) {
      dropped.push({ path: hit.path, step: guarded.step });
      continue;
    }
    if (rebuiltChars + guarded.body.length > opts.maxPackChars) break;
    rebuilt.push({ path: guarded.path, body: guarded.body });
    rebuiltChars += guarded.body.length;
  }
  return { kept: rebuilt, dropped, rebuilt: true };
}
