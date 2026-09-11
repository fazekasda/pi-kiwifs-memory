/**
 * T12: per-user-input RAG retrieval tests (PRD T12, architecture.md §3.1).
 *
 * Uses a fake adapter object shaped like KiwiFSAdapter (only the retrieval
 * surface is consumed). All data is synthetic; the fake backend enforces the
 * documented server-side behaviors (FTS SQL-side scope, semantic post-
 * candidate scope filter, hybrid keyword-only degradation, brief with no
 * scope parameter) per mcp-contracts.md §3/§4.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import type { HybridHit, ScoredHit } from "../src/backend/parse.ts";
import {
  MAX_SCOPE_QUERIES,
  PendingPackRegistry,
  RetrievalCoordinator,
  fingerprintInput,
  frameEvidence,
  matchKeyOf,
  type EvidenceItem,
  type EvidencePack,
} from "../src/retrieval/coordinator.ts";
import { identityRedactor } from "../src/backend/guard.ts";

const REDACTOR = identityRedactor;

// ---- fake adapter --------------------------------------------------------

interface FakeRecord {
  frontmatter: Record<string, string>;
  body: string;
}

function doc(frontmatter: Record<string, string>, body: string): string {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}`;
}

interface FakeAdapterOptions {
  records?: Record<string, FakeRecord>;
  fts?: (query: string, scope?: string) => ScoredHit[];
  semantic?: (query: string, scope?: string) => ScoredHit[];
  hybrid?: (query: string) => HybridHit[];
  hybridDegraded?: boolean;
  brief?: (
    query: string,
    pathPrefix?: string,
  ) => {
    sections: { path: string; body: string }[];
    dropped: { path: string }[];
  };
  /** Per-call delay in ms (real timers). */
  delayMs?: number;
  /** Calls never resolve until the signal aborts (deadline tests). */
  hang?: boolean;
}

function makeAdapter(opts: FakeAdapterOptions = {}): KiwiFSAdapter & {
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const records = opts.records ?? {};
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });

  async function gate<T>(
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    calls.push({ tool, args });
    if (opts.hang) await sleep(60_000, signal);
    if (opts.delayMs) await sleep(opts.delayMs, signal);
    return fn();
  }

  const adapter = {
    calls,
    async read(path: string, readOpts: { signal?: AbortSignal } = {}) {
      return gate(
        "kiwi_read",
        { path },
        () => {
          const r = records[path];
          if (!r) {
            return { state: "missing", frontmatter: {}, body: "" };
          }
          return {
            state: "ok",
            content: doc(r.frontmatter, r.body),
            frontmatter: r.frontmatter,
            body: r.body,
          };
        },
        readOpts.signal,
      );
    },
    async searchFts(
      query: string,
      searchOpts: { scope?: string; signal?: AbortSignal } = {},
    ) {
      const hits = opts.fts?.(query, searchOpts.scope) ?? [];
      // Server-side FTS honors scope; emulate: hits are pre-filtered.
      return gate(
        "kiwi_search",
        { query, scope: searchOpts.scope },
        () => ({ hits, text: "" }),
        searchOpts.signal,
      );
    },
    async searchSemantic(
      query: string,
      searchOpts: { scope?: string; signal?: AbortSignal } = {},
    ) {
      const hits = opts.semantic?.(query, searchOpts.scope) ?? [];
      return gate(
        "kiwi_search_semantic",
        { query, scope: searchOpts.scope },
        () => ({ hits, text: "" }),
        searchOpts.signal,
      );
    },
    async searchHybrid(
      query: string,
      searchOpts: { signal?: AbortSignal } = {},
    ) {
      const hits = opts.hybrid?.(query) ?? [];
      return gate(
        "kiwi_search_hybrid",
        { query },
        () => ({
          hits,
          degraded: opts.hybridDegraded ?? false,
          text: "",
        }),
        searchOpts.signal,
      );
    },
    async brief(
      query: string,
      briefOpts: { pathPrefix?: string; signal?: AbortSignal } = {},
    ) {
      const b = opts.brief?.(query, briefOpts.pathPrefix) ?? {
        sections: [],
        dropped: [],
      };
      return gate(
        "kiwi_brief",
        { query },
        () => ({ ...b, text: "" }),
        briefOpts.signal,
      );
    },
  } as unknown as KiwiFSAdapter & { calls: typeof calls };
  return adapter;
}

const SCOPE_A = "project/alpha";
const SCOPES = [SCOPE_A, "personal"];

function makeCoordinator(
  adapter: KiwiFSAdapter,
  overrides: Partial<
    ConstructorParameters<typeof RetrievalCoordinator>[0]
  > = {},
): RetrievalCoordinator {
  return new RetrievalCoordinator({
    adapter,
    authorizedScopes: SCOPES,
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: REDACTOR,
    ...overrides,
  });
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: text } as unknown as AgentMessage;
}

// ---- eligibility (§13 row 15) --------------------------------------------

test("slash commands, extension inputs and empty text are ineligible (no backend calls)", async () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter);
  for (const [text, source] of [
    ["/kiwifs-status", "interactive"],
    ["explain /etc/hosts", "extension"],
    ["   ", "interactive"],
  ] as const) {
    const outcome = await coordinator.retrieve(text, undefined, source);
    assert.equal(outcome.kind, "ineligible", `${text} / ${source}`);
  }
  assert.equal(adapter.calls.length, 0);
});

test("private mode holds retrieval with a visible note and zero network reads", async () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter, {
    privateMode: () => true,
  });
  const outcome = await coordinator.retrieve("hello", undefined, "interactive");
  assert.equal(outcome.kind, "degraded");
  assert.match((outcome as { reason: string }).reason, /private mode/);
  assert.equal(adapter.calls.length, 0);
});

test("empty authorized scope set holds retrieval visibly", async () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter, { authorizedScopes: [] });
  const outcome = await coordinator.retrieve("hello", undefined, "interactive");
  assert.equal(outcome.kind, "degraded");
  assert.match((outcome as { reason: string }).reason, /scope set is empty/);
  assert.equal(adapter.calls.length, 0);
});

// ---- scope enforcement + guard pipeline (AC3/AC6) -------------------------

const SCOPE_RECORDS: Record<string, FakeRecord> = {
  "project/alpha/memory/observations/2026/09/a1.md": {
    frontmatter: { scope: SCOPE_A, memory_status: "active" },
    body: "Alpha decided to use SQLite for the index.",
  },
  "project/beta/memory/observations/2026/09/b1.md": {
    frontmatter: { scope: "project/beta", memory_status: "active" },
    body: "Beta uses Postgres.",
  },
  "project/alpha/memory/observations/2026/09/forgotten.md": {
    frontmatter: { scope: SCOPE_A, memory_status: "superseded" },
    body: "forgotten claim",
  },
};

test("zero cross-scope hits: unscoped-leg hits from other scopes are rejected by the guard scope step", async () => {
  // Simulate a leg without a scope parameter returning cross-scope records.
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    semantic: () => [
      { path: "project/alpha/memory/observations/2026/09/a1.md", score: 0.9 },
      { path: "project/beta/memory/observations/2026/09/b1.md", score: 0.8 },
    ],
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve(
    "which database",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(pack.items.length >= 1);
  for (const item of pack.items) {
    assert.ok(
      SCOPES.includes(item.scope),
      `cross-scope item leaked: ${item.path}`,
    );
  }
  assert.equal(pack.items.filter((i) => i.scope === "project/beta").length, 0);
  assert.ok(
    pack.degraded.some((d) => d.includes("'scope'")),
    "guard scope rejection must be visible in degraded notes",
  );
});

test("forgotten (superseded) records can never enter a pack even when they surface", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    semantic: () => [
      {
        path: "project/alpha/memory/observations/2026/09/forgotten.md",
        score: 0.95,
      },
      { path: "project/alpha/memory/observations/2026/09/a1.md", score: 0.5 },
    ],
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve("db", undefined, "interactive");
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(pack.items.every((i) => !i.path.includes("forgotten")));
  assert.ok(pack.degraded.some((d) => d.includes("'status'")));
});

test("deleted records (missing read-back) are rejected before injection", async () => {
  const adapter = makeAdapter({
    records: {},
    fts: () => [
      { path: "project/alpha/memory/observations/2026/09/gone.md", score: 3 },
    ],
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve("db", undefined, "interactive");
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.equal(pack.items.length, 0);
  assert.ok(pack.degraded.some((d) => d.includes("'read-back'")));
});

// ---- brief scope gate + fallback rebuild (AC3, §13 row 4) ------------------

test("brief sections are guard-filtered; below-threshold pack rebuilds from scoped search", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => [
      { path: "project/alpha/memory/observations/2026/09/a1.md", score: 2 },
    ],
    brief: () => ({
      sections: [
        // Cross-scope page inside the brief pack (brief has no scope param).
        {
          path: "project/beta/memory/observations/2026/09/b1.md",
          body: "Beta uses Postgres.",
        },
      ],
      dropped: [],
    }),
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve(
    "databases",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  // The cross-scope brief section was dropped; the pack was rebuilt from the
  // guarded scoped FTS hit, so only the alpha record remains.
  assert.ok(pack.items.every((i) => i.scope !== "project/beta"));
  assert.ok(pack.items.some((i) => i.path.endsWith("a1.md")));
  assert.ok(pack.degraded.some((d) => d.includes("rebuilt")));
  assert.ok(pack.degraded.some((d) => d.includes("'scope'")));
});

// ---- hybrid attribution / vector fallback (AC5) ----------------------------

test("keyword-only hybrid attribution is reported degraded, never as semantic evidence", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    hybrid: () => [
      {
        path: "project/alpha/memory/observations/2026/09/a1.md",
        attribution: "keyword only",
        rank: 1,
      },
    ],
    hybridDegraded: true,
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve(
    "sqlite",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(
    pack.degraded.some(
      (d) => d.includes("keyword-only") || d.includes("keyword only"),
    ),
  );
  const framed = frameEvidence(pack.items);
  assert.match(framed, /degraded: keyword-only attribution/);
});

// ---- B4 semantic under-recall (AC3) ----------------------------------------

test("semantic scope-leg under-recall is measured and reported (B4)", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: (_q, scope) =>
      scope === SCOPE_A
        ? [
            {
              path: "project/alpha/memory/observations/2026/09/a1.md",
              score: 2,
            },
          ]
        : [],
    semantic: () => [], // post-candidate filter drops everything for the scope
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve(
    "sqlite",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(
    pack.degraded.some((d) => d.includes("under-recall") && d.includes("B4")),
  );
});

// ---- single total deadline (AC4) -------------------------------------------

test("one total deadline covers the whole fanout; expiry injects nothing and records degradation", async () => {
  const adapter = makeAdapter({ hang: true });
  const coordinator = makeCoordinator(adapter, { deadlineMs: 80 });
  const start = Date.now();
  const outcome = await coordinator.retrieve(
    "sqlite",
    undefined,
    "interactive",
  );
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "degraded");
  assert.ok(
    elapsed < 3000,
    `deadline must permit Pi continuation (took ${elapsed}ms)`,
  );
  assert.match((outcome as { reason: string }).reason, /deadline/);
  assert.match(coordinator.lastDegradedNote ?? "", /deadline/);
});

test("budget exhaustion skips remaining scope queries with a logged degradation", async () => {
  // Deterministic clock: each backend call advances the fake clock past the
  // budget so remaining scope queries must be skipped (deadline timer never
  // fires, so the cycle still completes with the evidence it gathered).
  let clock = 1_000_000;
  const tick = () => {
    clock += 600;
  };
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => {
      tick();
      return [
        { path: "project/alpha/memory/observations/2026/09/a1.md", score: 1 },
      ];
    },
    semantic: () => {
      tick();
      return [];
    },
    brief: () => {
      tick();
      return { sections: [], dropped: [] };
    },
  });
  const coordinator = makeCoordinator(adapter, {
    deadlineMs: 2000,
    now: () => clock,
    tokenizer: wordTokenizer,
  });
  const outcome = await coordinator.retrieve(
    "sqlite",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(pack.degraded.some((d) => d.includes("deadline budget exhausted")));
});

// ---- tokenizer / token accounting (AC7) -------------------------------------

/** Deterministic whitespace tokenizer (test stand-in for a model tokenizer). */
const wordTokenizer = {
  id: "test-whitespace",
  countTokens(text: string): number | undefined {
    if (/\u0000/.test(text)) return undefined;
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  },
};

const MULTILINGUAL_AND_CODE =
  "Décision : utiliser SQLite — 索引選択\n```sql\nSELECT * FROM memories WHERE scope = 'project/alpha';\n```";

test("tokenizer counts the COMPLETE payload including framing, citations, multilingual text and code", () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter, {
    tokenizer: wordTokenizer,
    tokenCap: 3000,
  });
  const items: EvidenceItem[] = [
    {
      path: "project/alpha/memory/observations/2026/09/a1.md",
      scope: SCOPE_A,
      body: MULTILINGUAL_AND_CODE,
      score: 1,
      leg: "fts",
    },
  ];
  const pack = coordinator.buildPack("raw input", undefined, items, []);
  assert.equal(pack.injectionAllowed, true);
  const framed = frameEvidence(pack.items);
  // Framing + citations are inside the counted payload.
  assert.equal(pack.tokenCount, wordTokenizer.countTokens(framed));
  const framedCount = wordTokenizer.countTokens(MULTILINGUAL_AND_CODE);
  assert.ok(framedCount !== undefined);
  assert.ok(pack.tokenCount! > framedCount);
});

test("cap enforcement drops lowest-ranked evidence until the framed payload fits", () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter, { tokenizer: wordTokenizer });
  const items: EvidenceItem[] = [
    {
      path: "p/1.md",
      scope: SCOPE_A,
      body: "a ".repeat(50),
      score: 3,
      leg: "fts",
    },
    {
      path: "p/2.md",
      scope: SCOPE_A,
      body: "b ".repeat(50),
      score: 2,
      leg: "fts",
    },
    {
      path: "p/3.md",
      scope: SCOPE_A,
      body: "c ".repeat(50),
      score: 1,
      leg: "fts",
    },
  ];
  const pack = coordinator.buildPack("raw", undefined, items, []);
  assert.equal(pack.injectionAllowed, true);
  assert.ok(pack.tokenCount! <= 3000);
  // With a tight cap only the top-ranked evidence survives.
  const tight = makeCoordinator(adapter, {
    tokenizer: wordTokenizer,
    tokenCap: 30,
  });
  const tightPack = tight.buildPack("raw", undefined, items, []);
  assert.ok(tightPack.tokenCount! <= 30);
  assert.ok(tightPack.items.length < items.length);
  if (tightPack.items.length > 0) {
    assert.equal(tightPack.items[0]!.path, "p/1.md");
  }
});

test("without a reliable tokenizer automatic injection is skipped visibly", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => [
      { path: "project/alpha/memory/observations/2026/09/a1.md", score: 2 },
    ],
  });
  const noTokenizer = makeCoordinator(adapter);
  const outcome = await noTokenizer.retrieve(
    "sqlite",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.equal(pack.injectionAllowed, false);
  assert.equal(pack.tokenCount, undefined);
  assert.ok(pack.degraded.some((d) => d.includes("no reliable tokenizer")));
  assert.match(noTokenizer.lastDegradedNote ?? "", /no reliable tokenizer/);

  // A tokenizer that cannot classify the payload fails closed the same way.
  const flaky = makeCoordinator(adapter, {
    tokenizer: { id: "flaky", countTokens: () => undefined },
  });
  const outcome2 = await flaky.retrieve("sqlite", undefined, "interactive");
  assert.equal(outcome2.kind, "pack");
  assert.equal(
    (outcome2 as { pack: EvidencePack }).pack.injectionAllowed,
    false,
  );
});

// ---- pending pack registry / matched consumption (fixture 11 engine) -------

test("registry consumes only on the LAST user message — history membership alone never matches", () => {
  const registry = new PendingPackRegistry();
  const pack: EvidencePack = {
    inputId: fingerprintInput("needle", "steer"),
    rawText: "needle",
    streamingBehavior: "steer",
    generation: 1,
    items: [],
    degraded: [],
    injectionAllowed: true,
    createdAt: "2026-09-08T00:00:00Z",
  };
  registry.add(pack, "queued");
  // The pack's text appears in HISTORY, but the last user message differs.
  const messages = [
    userMsg("needle"),
    assistantMsg("answer"),
    userMsg("next question"),
  ];
  const r1 = registry.consumeMatching(messages);
  assert.equal(r1.matched, false);
  if (!r1.matched) assert.equal(r1.reason, "no-pending-match");
  // Consuming only when the pack's input IS the last user message.
  const r2 = registry.consumeMatching([...messages.slice(0, 1)]);
  assert.equal(r2.matched, true);
});

test("tool-loop replay of the same message never re-consumes (same-occurrence guard)", () => {
  const registry = new PendingPackRegistry();
  registry.add(
    {
      inputId: "i1",
      rawText: "repeat me",
      generation: 1,
      items: [],
      degraded: [],
      injectionAllowed: true,
      createdAt: "x",
    },
    "fresh",
  );
  const messages = [userMsg("repeat me"), assistantMsg("tool call")];
  assert.equal(registry.consumeMatching(messages).matched, true);
  // Same message list (tool-loop provider call): not a new occurrence.
  const r = registry.consumeMatching([
    ...messages,
    assistantMsg("tool result"),
  ]);
  assert.equal(r.matched, false);
  if (!r.matched) assert.equal(r.reason, "same-occurrence");
});

test("repeated identical queued text: each new occurrence consumes its own pack (FIFO)", () => {
  const registry = new PendingPackRegistry();
  registry.add(
    {
      inputId: "p1",
      rawText: "status?",
      generation: 1,
      items: [],
      degraded: [],
      injectionAllowed: true,
      createdAt: "x",
    },
    "queued",
  );
  registry.add(
    {
      inputId: "p2",
      rawText: "status?",
      generation: 1,
      items: [],
      degraded: [],
      injectionAllowed: true,
      createdAt: "y",
    },
    "queued",
  );
  // Occurrence 1: one user message with this text.
  assert.equal(registry.consumeMatching([userMsg("status?")]).matched, true);
  // Same provider-call shape (tool loop): no second consumption.
  const rSame = registry.consumeMatching([
    userMsg("status?"),
    assistantMsg("t"),
  ]);
  assert.equal(rSame.matched, false);
  // Occurrence 2: the user sends the identical text AGAIN (new message).
  const r2 = registry.consumeMatching([userMsg("status?"), userMsg("status?")]);
  assert.equal(r2.matched, true);
  assert.equal(registry.pendingCount, 0);
});

test("transformed (expanded) eligible text still matches; slash inputs never register packs", async () => {
  // Eligible non-slash text passes through Pi's expansion unchanged, so the
  // raw-text matchKey matches the stored (expanded) message. Slash inputs
  // are ineligible upstream, so no pack exists to diverge.
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => [],
    semantic: () => [],
    hybrid: () => [],
  });
  const coordinator = makeCoordinator(adapter);
  const outcome = await coordinator.retrieve(
    "summarize decision X",
    "followUp",
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const messages = [userMsg("summarize decision X")]; // expanded == raw
  assert.equal(coordinator.registry.consumeMatching(messages).matched, true);

  const slash = await coordinator.retrieve(
    "/template args",
    "followUp",
    "interactive",
  );
  assert.equal(slash.kind, "ineligible");
  assert.equal(coordinator.registry.pendingCount, 0);
});

test("redaction never touches the fingerprint (raw unredacted input text is matching state)", async () => {
  const secret = "MY_SECRET_TOKEN_VALUE_1234";
  const queries: string[] = [];
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: (q) => {
      queries.push(q);
      return [];
    },
    semantic: () => [],
    hybrid: () => [],
  });
  const redactorCalls: string[] = [];
  const coordinator = makeCoordinator(adapter, {
    redact: (content: string) => {
      redactorCalls.push(content);
      // Simulate redaction replacing the secret in the OUTBOUND query.
      return { ok: true, content: content.replaceAll(secret, "[REDACTED:x]") };
    },
  });
  const raw = `check ${secret} in the config`;
  const outcome = await coordinator.retrieve(raw, "steer", "interactive");
  assert.equal(outcome.kind, "pack");
  // Outbound queries are redacted…
  for (const q of queries) assert.ok(!q.includes(secret));
  // …but the fingerprint matches the RAW text.
  assert.match(matchKeyOf(raw), /^[0-9a-f]{64}$/);
  const messages = [userMsg(raw)];
  assert.equal(coordinator.registry.consumeMatching(messages).matched, true);
});

test("duplicate inputId registration is rejected (one logical cycle per input)", () => {
  const registry = new PendingPackRegistry();
  const pack = (inputId: string): EvidencePack => ({
    inputId,
    rawText: "x",
    generation: 1,
    items: [],
    degraded: [],
    injectionAllowed: true,
    createdAt: "x",
  });
  assert.equal(registry.add(pack("same"), "fresh"), true);
  assert.equal(registry.add(pack("same"), "fresh"), false);
  assert.equal(registry.dropUnmatched().length, 1);
  assert.equal(
    registry.add(pack("same"), "fresh"),
    false,
    "consumed ids never re-register",
  );
});

test("repeated identical input through the REAL retrieve path: every occurrence registers and consumes (no silent loss)", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => [],
    semantic: () => [],
    hybrid: () => [],
  });
  const coordinator = makeCoordinator(adapter);
  // Two REAL retrieval cycles for the exact same text and behavior:
  const o1 = await coordinator.retrieve(
    "same question",
    undefined,
    "interactive",
  );
  const o2 = await coordinator.retrieve(
    "same question",
    undefined,
    "interactive",
  );
  assert.equal(o1.kind, "pack");
  assert.equal(o2.kind, "pack");
  const p1 = (o1 as { pack: EvidencePack }).pack;
  const p2 = (o2 as { pack: EvidencePack }).pack;
  // Occurrence 1 keeps the PRD fingerprint; occurrence 2 gets a distinct,
  // occurrence-unique id — a deterministic id alone would collide with the
  // session-permanent consumed-id set and silently lose retrieval.
  assert.equal(p1.inputId, fingerprintInput("same question", undefined));
  assert.notEqual(p2.inputId, p1.inputId);
  assert.notEqual(p2.inputId, fingerprintInput("same question", undefined));
  // Both occurrences are pending (registration never silently rejected).
  assert.equal(coordinator.registry.pendingCount, 2);
  // Each occurrence consumes its own pack, FIFO per occurrence.
  const c1 = coordinator.registry.consumeMatching([userMsg("same question")]);
  assert.equal(c1.matched, true);
  if (c1.matched) assert.equal(c1.pack.inputId, p1.inputId);
  const c2 = coordinator.registry.consumeMatching([
    userMsg("same question"),
    userMsg("same question"),
  ]);
  assert.equal(c2.matched, true);
  if (c2.matched) assert.equal(c2.pack.inputId, p2.inputId);
  assert.equal(coordinator.registry.pendingCount, 0);

  // A settle-time drop must not lock the identical input out forever: after
  // dropUnmatched adds the id to the permanent consumed set, a NEW occurrence
  // still registers and consumes (the occurrence counter keeps ids unique).
  const o3 = await coordinator.retrieve("drop me", undefined, "interactive");
  assert.equal(o3.kind, "pack");
  assert.equal(coordinator.registry.dropUnmatched().length, 1);
  const o4 = await coordinator.retrieve("drop me", undefined, "interactive");
  assert.equal(o4.kind, "pack");
  const p4 = (o4 as { pack: EvidencePack }).pack;
  assert.notEqual(p4.inputId, (o3 as { pack: EvidencePack }).pack.inputId);
  assert.equal(
    coordinator.registry.consumeMatching([userMsg("drop me")]).matched,
    true,
  );
});

test("unmatched packs fail closed at run settle and are dropped with visible status", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: () => [],
    semantic: () => [],
    hybrid: () => [],
  });
  const coordinator = makeCoordinator(adapter);
  await coordinator.retrieve("orphan question", "steer", "interactive");
  assert.equal(coordinator.registry.pendingCount, 1);
  // Run settles without any provider call consuming the input:
  const dropped = coordinator.registry.dropUnmatched();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.origin, "queued");
  // Dropped pack is never carried into a later unrelated turn:
  assert.equal(
    coordinator.registry.consumeMatching([userMsg("a later turn")]).matched,
    false,
  );
});

// ---- fanout bound (§13 row 3) ----------------------------------------------

test("scope fanout is bounded to 4; extra scopes are skipped with a logged degradation", async () => {
  const adapter = makeAdapter({
    records: SCOPE_RECORDS,
    fts: (_q, scope) => (scope ? [] : []),
    semantic: () => [],
  });
  const manyScopes = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const coordinator = makeCoordinator(adapter, {
    authorizedScopes: manyScopes,
  });
  const outcome = await coordinator.retrieve("q", undefined, "interactive");
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.ok(
    pack.degraded.some(
      (d) => d.includes("scope fanout bound") && d.includes("skipped"),
    ),
  );
  const scopeArgs = adapter.calls
    .filter((c) => c.tool === "kiwi_search")
    .map((c) => c.args["scope"]);
  assert.deepEqual(scopeArgs, ["s1", "s2", "s3", "s4"]);
  assert.equal(MAX_SCOPE_QUERIES, 4);
});
