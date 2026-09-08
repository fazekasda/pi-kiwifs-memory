/**
 * T04: KiwiFS MCP text-result parsers (mcp-contracts.md §3).
 *
 * KiwiFS returns tool results as text. The parsers below are the typed view
 * over those shapes: numbered `path (score)` hits, per-result hybrid engine
 * attribution, `Written <path> (ETag: <etag>)` mutation results, changes feed
 * lines with `last_seq`, frontmatter key/value pairs, and brief-pack sections.
 * Parsing never throws on unexpected shapes — it returns empty/unknown so the
 * caller can fail visibly rather than fabricate results.
 */

export type HybridAttribution = "both" | "keyword only" | "semantic only";

export interface ScoredHit {
  path: string;
  score: number;
}

export interface HybridHit {
  path: string;
  attribution: HybridAttribution;
  rank: number;
}

export interface ChangeEntry {
  action: "A" | "M" | "D" | string;
  path: string;
  actor?: string;
  timestamp?: string;
}

/** First `path (score)` match per numbered line. */
export function parseScoredHits(text: string): ScoredHit[] {
  const hits: ScoredHit[] = [];
  const re = /^\s*\d+\.\s+(\S+)\s+\(([\d.]+)\)/gm;
  for (const m of text.matchAll(re)) {
    hits.push({ path: m[1] as string, score: Number(m[2]) });
  }
  return hits;
}

/** Hybrid results: `N. path (attribution, #rank)`. */
export function parseHybridHits(text: string): HybridHit[] {
  const hits: HybridHit[] = [];
  const re =
    /^\s*\d+\.\s+(\S+)\s+\((both|keyword only|semantic only),\s*#(\d+)\)/gm;
  for (const m of text.matchAll(re)) {
    hits.push({
      path: m[1] as string,
      attribution: m[2] as HybridAttribution,
      rank: Number(m[3]),
    });
  }
  return hits;
}

/** A hybrid result set is degraded when any leg lacks semantic confirmation. */
export function hybridIsDegraded(hits: HybridHit[]): boolean {
  return hits.some((h) => h.attribution !== "both");
}

/** ETag from `Written <path> (ETag: <etag>)` / `Appended … (ETag: …)`. */
export function parseMutationEtag(text: string): string | undefined {
  const m = /\(ETag:\s*([^)\s]+)\)/.exec(text);
  return m?.[1];
}

/** `Deleted <path> (committed <hash>)` and plain `Deleted <path>`. */
export function parseDeletedPath(text: string): string | undefined {
  const m = /^Deleted\s+(\S+)/.exec(text);
  return m?.[1];
}

/** Changes feed: `- M path (actor: X, ts)` lines plus `last_seq: <cursor>`. */
export function parseChanges(text: string): {
  changes: ChangeEntry[];
  lastSeq?: string;
} {
  const changes: ChangeEntry[] = [];
  const re = /^-\s+([AMD])\s+(\S+)(?:\s+\(actor:\s*([^,]+),\s*([^)]+)\))?/gm;
  for (const m of text.matchAll(re)) {
    changes.push({
      action: m[1] as string,
      path: m[2] as string,
      ...(m[3] !== undefined ? { actor: m[3]!.trim() } : {}),
      ...(m[4] !== undefined ? { timestamp: m[4]!.trim() } : {}),
    });
  }
  const seq = /last_seq:\s*(\S+)/.exec(text)?.[1];
  return { changes, ...(seq !== undefined ? { lastSeq: seq } : {}) };
}

/** `key: value` lines (frontmatter or query_meta row headers). */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Frontmatter block of a markdown document (between leading `---` fences). */
export function parseFrontmatter(doc: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(doc);
  if (!m) return { frontmatter: {}, body: doc };
  return {
    frontmatter: parseKeyValueLines(m[1] as string),
    body: m[2] ?? "",
  };
}

/**
 * Brief pack: sections of the form `=== path ===` followed by the page body,
 * plus the trailing "Dropped for budget:" manifest.
 */
export function parseBriefPack(text: string): {
  sections: { path: string; body: string }[];
  dropped: { path: string }[];
} {
  const sections: { path: string; body: string }[] = [];
  const re = /^===\s+(\S+)\s+===$/gm;
  const marks: { path: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    marks.push({
      path: m[1] as string,
      start: (m.index ?? 0) + m[0].length,
      end: 0,
    });
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    const dropIdx = text.indexOf("Dropped for budget:", cur.start);
    const stop = next ? next.start - next.path.length - 8 : dropIdx;
    const end = stop < 0 ? (dropIdx < 0 ? text.length : dropIdx) : stop;
    sections.push({ path: cur.path, body: text.slice(cur.start, end).trim() });
  }
  const dropped: { path: string }[] = [];
  const dropIdx = text.indexOf("Dropped for budget:");
  if (dropIdx >= 0) {
    for (const m of text.slice(dropIdx).matchAll(/^- (\S+) \(/gm)) {
      dropped.push({ path: m[1] as string });
    }
  }
  return { sections, dropped };
}
