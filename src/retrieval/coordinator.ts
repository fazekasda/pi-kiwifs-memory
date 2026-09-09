/**
 * T12: per-user-input RAG retrieval coordinator (architecture.md §3.1,
 * PRD T12, decisions.md #7/#12, B3/B4).
 *
 * One logical retrieval cycle per eligible user input:
 * - `input` events are awaited by Pi before the first LLM call (verified:
 *   agent-session.js:844–854), for fresh AND queued (steer/followUp) inputs
 *   alike — so retrieval happens at submit time. Tool-loop LLM calls emit no
 *   `input` event and never repeat a cycle.
 * - ONE total deadline (confirmed 2 s default, decisions.md #7) covers query
 *   build, ALL backend calls, dedupe and ranking — a single AbortController,
 *   not per-attempt budgets. Expiry injects nothing and records a sanitized
 *   degraded status; Pi continues (cancellation propagates into MCP calls).
 * - Fanout bound: at most MAX_SCOPE_QUERIES = 4 authorized scope values [P]
 *   (§13 row 3). Extra scopes are skipped with a logged degradation. Scope
 *   enforcement: FTS and semantic carry the server-side `scope` param;
 *   `kiwi_brief` has NO scope parameter — it runs at most once, pinned to a
 *   `memory/` path prefix, and EVERY section passes the full B3 guard
 *   pipeline (guardCandidate); when the filtered pack falls below the
 *   minimum-evidence threshold it is rebuilt from guarded scoped search hits
 *   (§13 row 4). Hybrid runs at most once (no scope param) and its engine
 *   attribution is honored: `keyword only` is reported as degraded and never
 *   counted as semantic evidence (B3/B4).
 * - Every candidate record passes the 5-step fail-closed guard pipeline
 *   (src/backend/guard.ts) before it can enter a pack.
 * - Token accounting (§3.1, §13 row 5): the COMPLETE framed payload
 *   (evidence + framing + source-ID citations) is counted with a
 *   model-compatible tokenizer against the confirmed cap. Without a reliable
 *   tokenizer automatic injection is skipped with a visible degraded status
 *   (src/retrieval/tokenizer.ts) — never enforced by character estimates.
 *
 * Matched queued-input consumption (fixture 11, §13 row 6): packs are
 * registered with an occurrence-unique inputId — SHA-256(raw input-event
 * text + streamingBehavior) for the first occurrence of that exact input,
 * re-hashed with a per-coordinator occurrence counter for every repeated
 * identical input — local matching state, never outbound (raw text is
 * fingerprinted pre-redaction and pre-expansion; redaction applies to
 * queries, never to the fingerprint). Queued packs are consumed by
 * PendingPackRegistry.consumeMatching only on the provider call whose
 * LAST user message carries the pack's matchKey (SHA-256 of the message
 * text) AND represents a newly appended occurrence — history membership
 * alone never matches, tool-loop replays of the same message never
 * re-consume, repeated identical queued text consumes its own pack per
 * occurrence, and an unmatched pack is dropped fail-closed at run settle
 * with a visible degraded status (never carried into a later turn).
 *
 * All degradation notes are sanitized: event kind + bounded reason, no user
 * content, no secrets (§10).
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KiwiFSAdapter } from "../backend/adapter.ts";
import {
  guardCandidate,
  buildBriefEvidence,
  type GuardDeps,
  type Redactor,
} from "../backend/guard.ts";
import { createRedactor } from "../privacy/redaction.ts";
// T13: the framing moved to src/inject/packer.ts so the token-accounted
// payload and the injected rendering cannot diverge. Type-only cycle is
// erased at runtime.
import { frameEvidence } from "../inject/packer.ts";
import { TOKENIZER_UNAVAILABLE_NOTE } from "./tokenizer.ts";
import type { EvidenceTokenizer } from "./tokenizer.ts";

/** §13 row 3 default: at most 4 authorized scope values per retrieval [P]. */
export const MAX_SCOPE_QUERIES = 4;

/** §13 row 4 default: brief-pack minimum-evidence fraction of the cap [P]. */
export const MIN_EVIDENCE_FRACTION = 0.25;

export type StreamBehavior = "steer" | "followUp";

/** inputId fingerprint: raw UNREDACTED input text + streaming behavior. */
export function fingerprintInput(
  rawText: string,
  streamingBehavior?: StreamBehavior,
): string {
  return createHash("sha256")
    .update(rawText)
    .update("\u0000")
    .update(streamingBehavior ?? "")
    .digest("hex");
}

/**
 * Occurrence-unique inputId: the base fingerprint (raw text + behavior) for
 * the FIRST occurrence of an exact input; re-hashed with a per-coordinator
 * occurrence counter (1-based) for every repeat. Occurrence-uniqueness is
 * required because the registry's consumed-id set is session-permanent:
 * a deterministic id would make the second identical input (and any input
 * whose pack was settled away) silently unregisterable.
 */
export function occurrenceInputId(base: string, occurrence: number): string {
  if (occurrence <= 1) return base;
  return createHash("sha256")
    .update(base)
    .update("#occ:")
    .update(String(occurrence))
    .digest("hex");
}

/** Text-only match key for matching a pending pack against a user message. */
export function matchKeyOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Extract comparable text from a user message (string or content blocks). */
export function extractUserText(message: AgentMessage): string {
  const content: unknown = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/** Number of user messages in a context message list. */
export function countUserMessages(messages: readonly AgentMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/** Index of the LAST user message, or -1 when none exists. */
export function lastUserMessageIndex(
  messages: readonly AgentMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

export interface EvidenceItem {
  path: string;
  scope: string;
  body: string;
  score: number;
  /** Leg that produced the hit, for engine attribution/status. */
  leg: "fts" | "semantic" | "hybrid" | "brief";
  /** Hybrid engine attribution when the leg is hybrid. */
  attribution?: "both" | "keyword only" | "semantic only";
}

export interface EvidencePack {
  inputId: string;
  /** Raw input text — local matching state, never outbound. */
  rawText: string;
  streamingBehavior?: StreamBehavior;
  generation: number;
  items: EvidenceItem[];
  /** Sanitized degradation notes (metadata only, no user content). */
  degraded: string[];
  /**
   * False when automatic injection must be skipped (no reliable tokenizer):
   * the pack exists, tools remain available, nothing is auto-injected.
   */
  injectionAllowed: boolean;
  /** Token count of the complete framed payload (undefined when skipped). */
  tokenCount?: number;
  createdAt: string;
}

export type RetrievalOutcome =
  | { kind: "pack"; pack: EvidencePack }
  | {
      kind: "ineligible";
      reason: "slash-command" | "extension-source" | "empty-text";
    }
  | {
      kind: "degraded";
      /** Sanitized reason (error names / policy wording, never user text). */
      reason: string;
    };

export interface PendingPack {
  pack: EvidencePack;
  origin: "fresh" | "queued";
}

export type ConsumeResult =
  | { matched: true; pack: EvidencePack }
  | {
      matched: false;
      reason: "no-user-message" | "no-pending-match" | "same-occurrence";
    };

/**
 * Registry of packs awaiting injection (fixture 11 matching engine).
 *
 * Matching contract (docs/research/mcp-contracts.md §9 fixture 11,
 * architecture.md §3.1):
 * - A pending pack is consumed ONLY on the provider call whose LAST user
 *   message matches the pack's text-only matchKey AND whose user-message
 *   count is NEW for that key — a NEWLY consumed occurrence. Tool-loop
 *   replays (same last user message, same count) never re-consume.
 * - Occurrence tracking is a per-key SET of seen counts, not a single
 *   "last" value: counts are also recorded when a match attempt finds NO
 *   pending pack. This barrier is what makes fresh-turn injection (T13
 *   `before_agent_start`, which observes the prompt but not the message
 *   list) compose with the queued path: the fresh run's first provider
 *   calls record the baseline count for the input's key, so a later
 *   identical-text steer pack cannot be consumed by a tool-loop call that
 *   is still replaying the fresh turn's message — only a call with a new
 *   count (the queued input actually appended to history) can consume it.
 * - Repeated identical queued text: each queued input registered its own
 *   pack (FIFO per matchKey); each new occurrence consumes the oldest.
 * - Transformations: fingerprints use the raw pre-expansion input text;
 *   `/`-prefixed inputs are ineligible so template/skill expansion can never
 *   diverge an eligible fingerprint (architecture.md §3.1).
 * - History membership alone is insufficient: only the LAST user message is
 *   considered, and only for a pending (unconsumed) pack.
 * - Fail closed: no pending match → nothing injected; the pack stays
 *   pending for the remainder of the run and is dropped at run settle.
 */
export class PendingPackRegistry {
  private pending: PendingPack[] = [];
  /** inputIds already consumed — context-event dedupe across tool loops. */
  private consumed = new Set<string>();
  /** matchKey → user-message counts already matched (consumed or no-match). */
  private seenCounts = new Map<string, Set<number>>();

  /** Bounds for the seen-count bookkeeping (bounded local state, §9). */
  private static readonly MAX_KEYS = 512;
  private static readonly MAX_COUNTS_PER_KEY = 64;

  private recordCount(key: string, count: number): void {
    if (
      this.seenCounts.size >= PendingPackRegistry.MAX_KEYS &&
      !this.seenCounts.has(key)
    ) {
      // FIFO eviction of the oldest key — bounded memory, never correctness:
      // an evicted barrier can only re-permit an occurrence-guard edge case
      // for long-past inputs, never resurrect a consumed pack (the pack
      // itself is already removed and its inputId stays in `consumed`).
      const oldest = this.seenCounts.keys().next().value;
      if (oldest !== undefined) this.seenCounts.delete(oldest);
    }
    let set = this.seenCounts.get(key);
    if (!set) {
      set = new Set();
      this.seenCounts.set(key, set);
    }
    if (set.size >= PendingPackRegistry.MAX_COUNTS_PER_KEY) {
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
    set.add(count);
  }

  /** Register a pack (fresh or queued). Rejects duplicate inputIds. */
  add(pack: EvidencePack, origin: "fresh" | "queued"): boolean {
    if (this.consumed.has(pack.inputId)) return false;
    if (this.pending.some((p) => p.pack.inputId === pack.inputId)) return false;
    this.pending.push({ pack, origin });
    return true;
  }

  isConsumed(inputId: string): boolean {
    return this.consumed.has(inputId);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  pendingByInputId(inputId: string): PendingPack | undefined {
    return this.pending.find((p) => p.pack.inputId === inputId);
  }

  /**
   * Attempt matched consumption against the provider-call message list.
   * See the class contract above. Returns unmatched (fail closed) rather
   * than guessing; the caller decides whether to retry on a later fire.
   */
  consumeMatching(messages: readonly AgentMessage[]): ConsumeResult {
    const idx = lastUserMessageIndex(messages);
    if (idx < 0) return { matched: false, reason: "no-user-message" };
    const key = matchKeyOf(extractUserText(messages[idx]!));
    const userMsgCount = countUserMessages(messages);
    if (this.seenCounts.get(key)?.has(userMsgCount)) {
      // This user message (same key, same count) was already matched — a
      // tool-loop replay of a call that either consumed a pack or found
      // none. Never re-inject on it.
      return { matched: false, reason: "same-occurrence" };
    }
    // Barrier FIRST: every (key, count) pair is single-use whether or not a
    // pending pack matches. Recording only on the no-pending branch would let
    // a queued pack registered for the SAME text as a fresh run's input be
    // consumed by the fresh run's baseline context call (count 1) before the
    // queued input ever appended to history — a stale-occurrence injection.
    this.recordCount(key, userMsgCount);
    const pendingIdx = this.pending.findIndex(
      (p) => matchKeyOf(p.pack.rawText) === key,
    );
    if (pendingIdx < 0) {
      return { matched: false, reason: "no-pending-match" };
    }
    const [entry] = this.pending.splice(pendingIdx, 1);
    this.consumed.add(entry!.pack.inputId);
    return { matched: true, pack: entry!.pack };
  }

  /**
   * Consume the pending FRESH pack matching a `before_agent_start` prompt
   * (T13). Only origin="fresh" packs are eligible: a queued pack with the
   * identical text belongs to a steer/followUp input that Pi delivers via
   * the context path, never via a new before_agent_start. Fail closed:
   * no matching fresh pack → undefined (nothing injected). The fresh pack
   * is consumed WITHOUT recording a user-message count — at
   * before_agent_start the run's message list does not exist yet; the
   * baseline count is recorded by the first consumeMatching calls (barrier
   * semantics above).
   */
  consumeFresh(prompt: string): EvidencePack | undefined {
    const key = matchKeyOf(prompt);
    const idx = this.pending.findIndex(
      (p) => p.origin === "fresh" && matchKeyOf(p.pack.rawText) === key,
    );
    if (idx < 0) return undefined;
    const [entry] = this.pending.splice(idx, 1);
    this.consumed.add(entry!.pack.inputId);
    return entry!.pack;
  }

  /**
   * Drop packs still unmatched at run settle (agent_settled): fail closed,
   * visible degraded status, never carried into a later unrelated turn.
   * Returns the dropped packs (their inputIds — no user content).
   */
  dropUnmatched(): { inputId: string; origin: string }[] {
    const dropped = this.pending.map((p) => ({
      inputId: p.pack.inputId,
      origin: p.origin,
    }));
    for (const d of dropped) this.consumed.add(d.inputId);
    this.pending = [];
    return dropped;
  }

  clear(): void {
    this.pending = [];
  }

  /** Test/inspection: seen-count barrier keys (metadata only). */
  get barrierKeyCount(): number {
    return this.seenCounts.size;
  }
}

export interface RetrievalCoordinatorOptions {
  adapter: KiwiFSAdapter;
  /** Authorized scope set, e.g. ["project/demo", "personal"]. */
  authorizedScopes: string[];
  /** Configured total deadline in ms (decisions.md #7, default 2000). */
  deadlineMs: number;
  /** Confirmed evidence token cap (decisions.md #7, default 3000). */
  tokenCap: number;
  /** Model-compatible tokenizer; absence skips automatic injection visibly. */
  tokenizer?: EvidenceTokenizer;
  redact?: Redactor;
  generation: number;
  /** Private mode probe (T06): true → no network reads (fail visible). */
  privateMode?: () => boolean;
  now?: () => number;
}

export class RetrievalCoordinator {
  readonly registry = new PendingPackRegistry();
  private readonly adapterField: KiwiFSAdapter;
  private readonly authorizedScopes: string[];
  private readonly deadlineMs: number;
  private readonly tokenCap: number;
  private tokenizer: EvidenceTokenizer | undefined;
  private readonly redactField: Redactor;
  private generation: number;
  private readonly privateMode: () => boolean;
  private readonly now: () => number;
  /** Latest sanitized degradation note, for status surfacing. */
  private lastNote: string | undefined;
  /** Base inputId → occurrence count (occurrence-unique pack ids). */
  private readonly occurrences = new Map<string, number>();

  constructor(options: RetrievalCoordinatorOptions) {
    this.adapterField = options.adapter;
    this.authorizedScopes = [...options.authorizedScopes];
    this.deadlineMs = options.deadlineMs;
    this.tokenCap = options.tokenCap;
    this.tokenizer = options.tokenizer;
    this.redactField = options.redact ?? createRedactor();
    this.generation = options.generation;
    this.privateMode = options.privateMode ?? (() => false);
    this.now = options.now ?? (() => Date.now());
  }

  setGeneration(generation: number): void {
    this.generation = generation;
  }

  /**
   * T13: attach a user-configured tokenizer after runtime construction
   * (the config-specified tokenizer module loads asynchronously; inputs
   * arriving before it resolves visibly skip automatic injection).
   * Attaching a tokenizer never re-counts older packs: only inputs
   * retrieved after attachment are injection-eligible.
   */
  setTokenizer(tokenizer: EvidenceTokenizer): void {
    if (this.tokenizer === undefined) this.tokenizer = tokenizer;
  }

  /** The guarded backend adapter (T13 recall tools reuse the same pipeline). */
  get adapter(): KiwiFSAdapter {
    return this.adapterField;
  }

  /** Authorized scope set (copy; T13 recall tools read this). */
  scopeSet(): string[] {
    return [...this.authorizedScopes];
  }

  /** The configured redactor (T13 recall tools reuse the exact pipeline). */
  get guardRedactor(): Redactor {
    return this.redactField;
  }

  /**
   * Redact a search query (T13 recall tools): classification failure is a
   * typed refusal — the tool never sends an unclassified query outbound.
   */
  redactQuery(
    text: string,
  ): { ok: true; content: string } | { ok: false; reason: string } {
    return this.redactField(text);
  }

  private get redact(): Redactor {
    return this.redactField;
  }

  get lastDegradedNote(): string | undefined {
    return this.lastNote;
  }

  private note(message: string): void {
    this.lastNote = message;
  }

  /**
   * Eligibility policy (§13 row 15): fresh + queued text inputs are
   * eligible; `/`-prefixed inputs (slash commands, skills, prompt templates
   * — anything subject to expansion) and extension-generated inputs are
   * ineligible. Eligibility is a policy check, never an error.
   */
  eligible(text: string, source: string): boolean {
    if (source === "extension") return false;
    if (text.startsWith("/")) return false;
    return text.trim() !== "";
  }

  /**
   * Run ONE retrieval cycle for one user input. Registered in the `input`
   * handler (awaited before the first LLM call — Pi-verified ordering), so
   * the returned pack exists before `before_provider_request`.
   */
  async retrieve(
    rawText: string,
    streamingBehavior: StreamBehavior | undefined,
    source: string,
  ): Promise<RetrievalOutcome> {
    if (!this.eligible(rawText, source)) {
      return {
        kind: "ineligible",
        reason: rawText.startsWith("/")
          ? "slash-command"
          : source === "extension"
            ? "extension-source"
            : "empty-text",
      };
    }
    if (this.privateMode()) {
      this.note(
        "retrieval held: private mode active — no network reads, no pack registered",
      );
      return {
        kind: "degraded",
        reason:
          "retrieval held: private mode active — no network reads, no pack registered",
      };
    }
    if (this.authorizedScopes.length === 0) {
      this.note("retrieval held: authorized scope set is empty");
      return {
        kind: "degraded",
        reason: "retrieval held: authorized scope set is empty",
      };
    }
    // Query redaction BEFORE any outbound call (decisions.md #10): the
    // search text can leak secrets into backend logs. Fingerprint uses the
    // RAW unredacted text (local matching state, never outbound).
    let query: string;
    try {
      const redacted = this.redact(rawText);
      if (!redacted.ok) {
        this.note("retrieval skipped: query failed privacy classification");
        return {
          kind: "degraded",
          reason: "retrieval skipped: query failed privacy classification",
        };
      }
      query = redacted.content;
    } catch (err) {
      this.note(`retrieval skipped: redaction error (${(err as Error).name})`);
      return {
        kind: "degraded",
        reason: `retrieval skipped: redaction error (${(err as Error).name})`,
      };
    }

    const degraded: string[] = [];
    const controller = new AbortController();
    const started = this.now();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, this.deadlineMs),
    );
    // Never hold process shutdown on the deadline timer.
    timer.unref?.();
    const signal = controller.signal;
    const expired = () =>
      signal.aborted || this.now() - started >= this.deadlineMs;

    try {
      const scopes = this.authorizedScopes.slice(0, MAX_SCOPE_QUERIES);
      if (this.authorizedScopes.length > MAX_SCOPE_QUERIES) {
        degraded.push(
          `scope fanout bound reached: ${this.authorizedScopes.length - MAX_SCOPE_QUERIES} scope query(es) skipped`,
        );
      }

      const guardDeps: GuardDeps = {
        adapter: this.adapter,
        authorizedScopes: this.authorizedScopes,
        redact: this.redact,
      };
      const byPath = new Map<string, EvidenceItem>();

      // Per-scope scope-critical legs (FTS SQL-side scope + semantic
      // server-side scope param, B4 under-recall disclosed via degraded
      // measurement below). All under the ONE shared deadline.
      for (const scope of scopes) {
        if (expired()) {
          degraded.push("scope query skipped: deadline budget exhausted");
          break;
        }
        const opts = { scope, signal };
        const fts = await this.safeCall(
          () => this.adapter.searchFts(query, { ...opts, limit: 10 }),
          degraded,
          "FTS query failed",
        );
        if (fts) {
          await this.collectHits(
            fts.hits.map((h) => ({ ...h, leg: "fts" as const })),
            guardDeps,
            byPath,
            degraded,
            signal,
          );
        }
        if (expired()) {
          degraded.push("scope query skipped: deadline budget exhausted");
          break;
        }
        const sem = await this.safeCall(
          () => this.adapter.searchSemantic(query, { ...opts, limit: 10 }),
          degraded,
          "semantic query failed",
        );
        if (sem) {
          await this.collectHits(
            sem.hits.map((h) => ({ ...h, leg: "semantic" as const })),
            guardDeps,
            byPath,
            degraded,
            signal,
          );
          // B4 measurement: semantic scope filtering is post-candidate
          // (200/4096 caps), so scoped under-recall is permanent and must
          // be reported, never hidden or promised away.
          const ftsCount = fts?.hits.length ?? 0;
          if (sem.hits.length < ftsCount) {
            degraded.push(
              `semantic scope leg under-recall (B4 post-candidate filter): ${sem.hits.length} semantic hit(s) vs ${ftsCount} FTS hit(s) for this scope`,
            );
          }
        }
      }

      // Hybrid: at most one query (no scope parameter exists). Engine
      // attribution is honored — `keyword only` is degraded, never semantic
      // evidence (B3/B4). All hits still pass the guard pipeline (the
      // client-side scope check is the only scope gate on this leg).
      if (expired()) {
        degraded.push("scope query skipped: deadline budget exhausted");
      } else {
        const hyb = await this.safeCall(
          () => this.adapter.searchHybrid(query, { signal, limit: 10 }),
          degraded,
          "hybrid query failed",
        );
        if (hyb) {
          if (hyb.degraded) {
            degraded.push(
              "hybrid search degraded: results lack full semantic attribution (keyword-only hits are not semantic evidence)",
            );
          }
          await this.collectHits(
            hyb.hits.map((h) => ({
              path: h.path,
              score: (h.rank + 1) * -1, // rank 1 = best; negative keeps ordering
              leg: "hybrid" as const,
              attribution: h.attribution,
            })),
            guardDeps,
            byPath,
            degraded,
            signal,
          );
        }
      }

      // Brief: at most one call, pinned inside the primary scope's memory/
      // namespace. Brief has NO scope parameter — every section passes the
      // full guard pipeline; below the minimum-evidence threshold the pack
      // is rebuilt from guarded scoped search results (§13 row 4).
      if (expired()) {
        degraded.push("scope query skipped: deadline budget exhausted");
      } else {
        const primary = scopes[0]!;
        const br = await this.safeCall(
          () =>
            this.adapter.brief(query, {
              pathPrefix: `${primary}/memory/`,
              signal,
            }),
          degraded,
          "brief query failed",
        );
        if (br) {
          const ftsHits = [...byPath.values()]
            .filter((i) => i.leg === "fts")
            .map((i) => ({ path: i.path, score: i.score }));
          const briefResult = await buildBriefEvidence(
            br.sections,
            ftsHits,
            guardDeps,
            { maxPackChars: this.tokenCap * 4, signal },
          );
          for (const dropped of briefResult.dropped) {
            degraded.push(
              `brief section dropped: guard step '${dropped.step}' rejected the page`,
            );
          }
          if (briefResult.rebuilt) {
            degraded.push(
              "brief pack below minimum-evidence threshold: rebuilt from guarded scoped search results",
            );
          }
          for (const kept of briefResult.kept) {
            this.upsert(byPath, {
              path: kept.path,
              scope: primary,
              body: kept.body,
              score: 0, // brief has no scores; ranked below scored legs
              leg: "brief",
            });
          }
        }
      }

      if (signal.aborted) {
        this.note("retrieval degraded: deadline exceeded before completion");
        return {
          kind: "degraded",
          reason: "retrieval degraded: deadline exceeded before completion",
        };
      }

      const items = [...byPath.values()].sort((a, b) => b.score - a.score);
      // B4 under-recall measurement: scoped semantic hits vs. total semantic
      // candidates are server-side post-candidate; the observable bound is
      // reported, never promised away.
      if (items.length === 0) {
        degraded.push("no evidence passed the guard pipeline for this input");
      }

      const pack = this.buildPack(rawText, streamingBehavior, items, degraded);
      const registered = this.registry.add(
        pack,
        streamingBehavior ? "queued" : "fresh",
      );
      if (!registered) {
        // Never silence a rejected registration: the pack would otherwise
        // exist without being consumable (silent retrieval loss).
        const reason = "retrieval degraded: pack registration rejected";
        pack.degraded.push(reason);
        this.note(reason);
      }
      return { kind: "pack", pack };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build the framed evidence pack with enforced token accounting: the
   * COMPLETE payload (framing + citations + bodies) is counted; lowest-
   * ranked evidence is dropped first until the count fits the cap. Without
   * a reliable tokenizer, `injectionAllowed` is false with a visible note.
   */
  buildPack(
    rawText: string,
    streamingBehavior: StreamBehavior | undefined,
    items: EvidenceItem[],
    degraded: string[],
  ): EvidencePack {
    const kept = [...items];
    const baseId = fingerprintInput(rawText, streamingBehavior);
    const occurrence = (this.occurrences.get(baseId) ?? 0) + 1;
    this.occurrences.set(baseId, occurrence);
    const base = {
      inputId: occurrenceInputId(baseId, occurrence),
      rawText,
      ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
      generation: this.generation,
      degraded,
      createdAt: new Date(this.now()).toISOString(),
    };
    if (this.tokenizer === undefined) {
      degraded.push(TOKENIZER_UNAVAILABLE_NOTE);
      this.note(TOKENIZER_UNAVAILABLE_NOTE);
      return {
        ...base,
        items: kept,
        injectionAllowed: false,
      };
    }
    for (;;) {
      const framed = frameEvidence(kept);
      const count = this.tokenizer.countTokens(framed);
      if (count === undefined) {
        // Tokenizer cannot classify this payload reliably: fail closed.
        degraded.push(TOKENIZER_UNAVAILABLE_NOTE);
        this.note(TOKENIZER_UNAVAILABLE_NOTE);
        return { ...base, items: kept, injectionAllowed: false };
      }
      if (count <= this.tokenCap || kept.length === 0) {
        return {
          ...base,
          items: kept,
          injectionAllowed: true,
          tokenCount: count,
        };
      }
      kept.pop(); // lowest-ranked first
    }
  }

  /** Guard + collect hits, deduped by path (best score wins). */
  private async collectHits(
    hits: {
      path: string;
      score: number;
      leg: EvidenceItem["leg"];
      attribution?: EvidenceItem["attribution"];
    }[],
    guardDeps: GuardDeps,
    byPath: Map<string, EvidenceItem>,
    degraded: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const hit of hits) {
      if (signal?.aborted) {
        degraded.push("guard step skipped: deadline budget exhausted");
        return;
      }
      const guarded = await this.safeCall(
        () => guardCandidate(hit.path, guardDeps, signal),
        degraded,
        "guard read-back failed",
      );
      if (guarded === undefined) continue;
      if (!guarded.ok) {
        degraded.push(
          `candidate rejected: guard step '${guarded.step}' (${hit.leg} leg)`,
        );
        continue;
      }
      this.upsert(byPath, {
        path: guarded.path,
        scope: guarded.scope,
        body: guarded.body,
        score: hit.score,
        leg: hit.leg,
        ...(hit.attribution !== undefined
          ? { attribution: hit.attribution }
          : {}),
      });
    }
  }

  private upsert(byPath: Map<string, EvidenceItem>, item: EvidenceItem): void {
    const existing = byPath.get(item.path);
    if (existing === undefined || item.score > existing.score) {
      byPath.set(item.path, item);
    }
  }

  /** Run a backend/guard call; failures become sanitized degradations. */
  private async safeCall<T>(
    fn: () => Promise<T>,
    degraded: string[],
    label: string,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      const name = (err as Error).name;
      if (name === "AbortError") {
        degraded.push("backend query aborted: retrieval deadline exceeded");
      } else {
        degraded.push(`${label} (${name})`);
      }
      return undefined;
    }
  }
}

// frameEvidence moved to src/inject/packer.ts (T13) — re-exported here so
// existing callers/tests keep one canonical framing function.
export { frameEvidence };
