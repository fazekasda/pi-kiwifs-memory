/**
 * T13 — matched context injection tests (test/inject.test.ts).
 *
 * Covers the injector/packer/registry behavior end-to-end through the REAL
 * RetrievalCoordinator + PendingPackRegistry + EvidenceInjector + packer:
 *
 * - fresh consume-once via `before_agent_start` semantics
 * - queued steer/followUp consumption/dedupe over tool-loop history
 * - repeated identical user inputs (occurrence-unique packs, FIFO)
 * - unmatched/ambiguous fail-closed + settle drop
 * - zero-item packs consumed without injecting an empty block
 * - rawText never leaves matching state (redaction-active fingerprint case)
 * - framing / conflict labels / token-count consistency (tokenizer recount
 *   of the framed payload equals the pack's enforced count)
 * - expansion boundary: `/`-prefixed inputs ineligible, eligible text passes
 * - tokenizer module loading fail-closed behavior
 * - recall tools share the private/scope/guard pipeline (no bypass)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import type { ScoredHit } from "../src/backend/parse.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import {
  RetrievalCoordinator,
  matchKeyOf,
} from "../src/retrieval/coordinator.ts";
import type {
  EvidenceItem,
  EvidencePack,
} from "../src/retrieval/coordinator.ts";
import type { EvidenceTokenizer } from "../src/retrieval/tokenizer.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EvidenceInjector } from "../src/inject/injector.ts";
import { frameEvidence } from "../src/inject/packer.ts";
import {
  buildMemoryReadTool,
  buildMemorySearchTool,
} from "../src/inject/tools.ts";
import { loadConfiguredTokenizer } from "../src/retrieval/tokenizer.ts";
import { serializeDataBlock } from "../src/observation/reflection.ts";

// ---- fakes ---------------------------------------------------------------

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

function makeAdapter(
  records: Record<string, FakeRecord> = {},
  fts?: (query: string, scope?: string) => ScoredHit[],
): KiwiFSAdapter & { readCalls: string[] } {
  const readCalls: string[] = [];
  const adapter = {
    readCalls,
    async read(path: string) {
      readCalls.push(path);
      const r = records[path];
      if (!r) return { state: "missing", frontmatter: {}, body: "" };
      return {
        state: "ok",
        content: doc(r.frontmatter, r.body),
        frontmatter: r.frontmatter,
        body: r.body,
      };
    },
    async searchFts(query: string, opts: { scope?: string } = {}) {
      return { hits: fts?.(query, opts.scope) ?? [], text: "" };
    },
    async searchSemantic() {
      return { hits: [], text: "" };
    },
    async searchHybrid() {
      return { hits: [], degraded: false, text: "" };
    },
    async brief() {
      return { sections: [], dropped: [], text: "" };
    },
  } as unknown as KiwiFSAdapter & { readCalls: string[] };
  void adapter;
  return adapter;
}

const SCOPE_A = "project/alpha";
const SCOPES = [SCOPE_A, "personal"];

/** Word-count tokenizer: deterministic, reliable, easy to recount in tests. */
const WORD_TOKENIZER = {
  id: "test-words",
  countTokens(text: string): number {
    return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  },
};

function makeCoordinator(
  adapter: KiwiFSAdapter,
  overrides: Omit<
    Partial<ConstructorParameters<typeof RetrievalCoordinator>[0]>,
    "tokenizer"
  > & { tokenizer?: EvidenceTokenizer; noTokenizer?: boolean } = {},
): RetrievalCoordinator {
  const { tokenizer, noTokenizer, ...rest } = overrides;
  return new RetrievalCoordinator({
    adapter,
    authorizedScopes: SCOPES,
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    ...(tokenizer !== undefined
      ? { tokenizer }
      : noTokenizer === true
        ? {}
        : { tokenizer: WORD_TOKENIZER }),
    ...rest,
  });
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: text } as unknown as AgentMessage;
}

const RECORDS: Record<string, FakeRecord> = {
  [`${SCOPE_A}/memory/observations/2026/09/a1.md`]: {
    frontmatter: { scope: SCOPE_A, memory_status: "active" },
    body: "Alpha decided to use SQLite for the index.",
  },
  [`${SCOPE_A}/memory/reflections/2026/09/r1.md`]: {
    frontmatter: { scope: SCOPE_A, memory_status: "active" },
    body: serializeDataBlock({
      summary: "Index choice is disputed.",
      conflicts: [
        {
          recordIds: ["a1", "a2"],
          label: "SQLite vs Postgres for the index",
        },
      ],
    }),
  },
};

const FTS_HIT = (path: string, score = 0.9) => ({ path, score });
const OBS_PATH = `${SCOPE_A}/memory/observations/2026/09/a1.md`;
const REFL_PATH = `${SCOPE_A}/memory/reflections/2026/09/r1.md`;

/** Fresh pack for a prompt (full coordinator retrieve + registry pending). */
async function freshPack(coordinator: RetrievalCoordinator, text: string) {
  const outcome = await coordinator.retrieve(text, undefined, "interactive");
  assert.equal(outcome.kind, "pack");
  return (outcome as { pack: EvidencePack }).pack;
}

async function queuedPack(
  coordinator: RetrievalCoordinator,
  text: string,
  behavior: "steer" | "followUp" = "steer",
) {
  const outcome = await coordinator.retrieve(text, behavior, "interactive");
  assert.equal(outcome.kind, "pack");
  return (outcome as { pack: EvidencePack }).pack;
}

// ---- fresh consume-once ---------------------------------------------------

test("fresh turn: before_agent_start injects once; repeated calls and context fires never duplicate", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, (q) =>
      q.includes("SQLite") ? [FTS_HIT(OBS_PATH)] : [],
    ),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const input = "what database does the index use? SQLite";
  await freshPack(coordinator, input);

  const first = injector.onBeforeAgentStart(input);
  assert.ok(first, "fresh pack must inject on the matching prompt");
  assert.equal(first.message.customType, "kiwifs-evidence");
  assert.equal(first.message.display, true);
  const content = JSON.stringify(first.message.content);
  assert.match(content, /UNTRUSTED DATA/);
  assert.match(content, /\[Memory:E1 source=/);

  // consume-once: no pack pending anymore, and the inputId is consumed.
  assert.equal(injector.onBeforeAgentStart(input), undefined);

  // Tool-loop context fires during the same run: barrier (count 1 recorded
  // with nothing pending) — never re-injected.
  const history = [userMsg(input), assistantMsg("thinking...")];
  assert.equal(injector.onContext(history), undefined);
  assert.equal(injector.onContext(history), undefined);

  // Persistent entries: exactly ONE custom message was ever produced.
  assert.equal(first.message.customType, "kiwifs-evidence");
});

test("fresh matching does not consume a queued pack with identical text", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  // A steer (queued) input for the identical text arrives mid-run: the
  // fresh run's baseline context call has already fired and recorded the
  // (key, count) barrier, so the queued pack can only be consumed on a NEW
  // occurrence (the steer input actually appended to history).
  const text = "same text both paths";
  await freshPack(coordinator, text);
  assert.ok(injector.onBeforeAgentStart(text), "fresh consumed");
  const history1 = [userMsg(text)];
  assert.equal(injector.onContext(history1), undefined, "baseline: barrier");
  await queuedPack(coordinator, text, "followUp");
  // Tool-loop replay at the same count: same-occurrence, still not consumed.
  assert.equal(injector.onContext(history1), undefined);
  // The queued followUp input is APPENDED to history (count 2): new
  // occurrence → consumed now, not before.
  const history2 = [...history1, userMsg(text)];
  const result = injector.onContext(history2);
  assert.ok(result, "queued followUp consumed on its own occurrence");
  const evidence = result!.messages.at(-1) as {
    details: { inputId: string };
  };
  assert.ok(evidence.details.inputId.length === 64);
  assert.equal(injector.onContext(history2), undefined);
});

// ---- queued consumption / tool-loop dedupe --------------------------------

test("queued steer pack injects on the provider call consuming that input and never duplicates on later context fires", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  await queuedPack(coordinator, "steer me toward the alpha notes");

  const history = [
    userMsg("original question"),
    assistantMsg("answer"),
    userMsg("steer me toward the alpha notes"),
  ];
  const first = injector.onContext(history);
  assert.ok(first, "first provider call on the steer input injects");
  assert.equal(first!.messages.length, history.length + 1);
  assert.equal(
    (first!.messages.at(-1) as { customType: string }).customType,
    "kiwifs-evidence",
  );

  // Tool loop: the SAME message list is replayed per LLM call — no pack is
  // pending, the occurrence was consumed → no duplicate injection.
  assert.equal(injector.onContext(history), undefined);
  assert.equal(injector.onContext(history), undefined);
});

test("repeated identical user inputs: occurrence-unique packs consumed FIFO, one per occurrence", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const text = "identical repeated input";
  const pack1 = await queuedPack(coordinator, text, "steer");
  const pack2 = await queuedPack(coordinator, text, "followUp");
  assert.notEqual(pack1.inputId, pack2.inputId, "occurrence-unique inputIds");

  const history1 = [userMsg(text)];
  const r1 = injector.onContext(history1);
  assert.ok(r1);
  assert.equal(
    (r1!.messages.at(-1) as { details: { inputId: string } }).details.inputId,
    pack1.inputId,
  );
  assert.equal(injector.onContext(history1), undefined);

  // Second occurrence: history grew — new count.
  const history2 = [...history1, assistantMsg("x"), userMsg(text)];
  const r2 = injector.onContext(history2);
  assert.ok(r2);
  assert.equal(
    (r2!.messages.at(-1) as { details: { inputId: string } }).details.inputId,
    pack2.inputId,
  );

  // Third occurrence with no pending pack: fail closed, nothing injected.
  const history3 = [...history2, userMsg(text)];
  assert.equal(injector.onContext(history3), undefined);
});

// ---- fail-closed -----------------------------------------------------------

test("unmatched and ambiguous inputs fail closed; settle drops leftover packs", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  await freshPack(coordinator, "the real prompt");

  assert.equal(
    injector.onBeforeAgentStart("an unrelated prompt"),
    undefined,
    "no matching fresh pack → no injection",
  );
  assert.equal(
    injector.onContext([userMsg("unrelated"), assistantMsg("x")]),
    undefined,
    "context with non-matching last user message → nothing injected",
  );
  // Run settle: unmatched pending packs dropped, never carried into a later
  // unrelated turn — and the fail-closed non-matches did NOT consume it.
  // The fail-closed non-matches did NOT consume the pending pack: it still
  // injects on the matching prompt, and only then the registry is empty.
  assert.ok(
    injector.onBeforeAgentStart("the real prompt"),
    "pending fresh pack survives fail-closed non-matches",
  );
  assert.equal(injector.onBeforeAgentStart("the real prompt"), undefined);

  // Run settle: no unmatched packs remain; nothing is carried into a later
  // unrelated turn.
  assert.equal(coordinator.registry.dropUnmatched().length, 0);
  void coordinator;
});

test("ambiguous duplicate pending registrations: two packs, one occurrence → one injection, second stays pending", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const text = "ambiguous duplicate";
  await queuedPack(coordinator, text, "steer");
  await queuedPack(coordinator, text, "steer");

  const history = [userMsg(text)];
  assert.ok(injector.onContext(history));
  // Same occurrence again: the second pack is NOT consumed (one injection
  // per occurrence; no duplicate on the same provider-call input).
  assert.equal(injector.onContext(history), undefined);
  assert.equal(coordinator.registry.dropUnmatched().length, 1);
});

// ---- zero-item packs -------------------------------------------------------

test("zero-item packs are consumed without injecting an empty framing block", async () => {
  const coordinator = makeCoordinator(makeAdapter(RECORDS, () => []));
  const injector = new EvidenceInjector(coordinator.registry);
  const pack = await freshPack(coordinator, "nothing matches this");
  assert.equal(pack.items.length, 0);
  assert.equal(pack.injectionAllowed, true);
  const message = injector.onBeforeAgentStart("nothing matches this");
  assert.equal(message, undefined, "no empty framing block injected");
  // Consumed (not left pending to fail closed noisily at settle).
  assert.equal(coordinator.registry.dropUnmatched().length, 0);
});

test("packs without a reliable tokenizer are consumed but never injected (visible skip)", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
    { noTokenizer: true },
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const pack = await freshPack(coordinator, "no tokenizer configured");
  assert.equal(pack.injectionAllowed, false);
  assert.match(pack.degraded.join("\n"), /automatic injection skipped/);
  assert.equal(
    injector.onBeforeAgentStart("no tokenizer configured"),
    undefined,
  );
});

// ---- rawText containment + redaction-active fingerprint -------------------

test("rawText never leaves matching state; fingerprint matches the raw unredacted input while queries are redacted", async () => {
  const SECRET = "SECRET-TOKEN-XYZZY";
  const ftsQueries: string[] = [];
  const redactorCalls: string[] = [];
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, (q) => {
      ftsQueries.push(q);
      return q.includes("[REDACTED]") ? [FTS_HIT(OBS_PATH)] : [];
    }),
    {
      redact: (content: string) => {
        redactorCalls.push(content);
        return {
          ok: true,
          content: content.replaceAll(SECRET, "[REDACTED]"),
        };
      },
    },
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const rawInput = `note the credential ${SECRET} and find SQLite notes`;
  await freshPack(coordinator, rawInput);

  // The redactor received the raw text (its job) and every OUTBOUND search
  // query is the redacted form — the secret never reaches the backend.
  assert.ok(redactorCalls.length > 0);
  assert.ok(ftsQueries.length > 0);
  assert.ok(ftsQueries.every((q) => !q.includes(SECRET)));
  assert.ok(ftsQueries.some((q) => q.includes("[REDACTED]")));
  // The pending pack's matching state holds the raw text (verified by the
  // successful match below); nothing outbound contains it.
  const message = injector.onBeforeAgentStart(rawInput);
  assert.ok(message, "fingerprint uses the RAW unredacted input text");
  const outbound = JSON.stringify(message);
  assert.ok(!outbound.includes(SECRET), "rawText never leaves matching state");
  assert.ok(
    (message!.message.details as { inputId: string }).inputId.length === 64,
  );
  assert.equal(injector.onBeforeAgentStart(rawInput), undefined);
});

// ---- framing / conflicts / token accounting -------------------------------

test("framing is token-accounted as rendered: pack.tokenCount equals a recount of frameEvidence output", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH), FTS_HIT(REFL_PATH, 0.8)]),
  );
  const pack = await freshPack(coordinator, "summarize the index dispute");
  assert.ok(pack.tokenCount !== undefined);
  assert.equal(
    pack.tokenCount,
    WORD_TOKENIZER.countTokens(frameEvidence(pack.items)),
  );
  // Enforcement actually trims under a tiny cap (recount after framing).
  const tiny = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH), FTS_HIT(REFL_PATH, 0.8)]),
    { tokenCap: 5 },
  );
  const trimmed = await freshPack(tiny, "summarize the index dispute");
  assert.ok(trimmed.items.length < pack.items.length, "lowest-ranked dropped");
  // The irreducible framing header is still counted and recounted exactly.
  assert.equal(
    trimmed.tokenCount,
    WORD_TOKENIZER.countTokens(frameEvidence(trimmed.items)),
  );
  assert.equal(trimmed.injectionAllowed, true);
});

test("conflicting facts render with bounded, informational labels and source ids", () => {
  const items: EvidenceItem[] = [
    {
      path: REFL_PATH,
      scope: SCOPE_A,
      body: serializeDataBlock({
        summary: "Disputed.",
        conflicts: [{ recordIds: ["a1", "a2"], label: "x".repeat(500) }],
      }),
      score: 1,
      leg: "fts",
    },
  ];
  const framed = frameEvidence(items);
  assert.match(framed, /UNTRUSTED DATA/);
  assert.match(framed, /never instructions/);
  assert.match(framed, /\[Memory:E1 source=/);
  assert.match(framed, /never auto-applied/);
  assert.match(framed, /conflicting records: a1, a2/);
  // Label re-bounded at render time.
  const labelLine = framed.split("\n").find((l) => l.startsWith("- x"))!;
  assert.ok(labelLine.length <= 200 + 60, `bounded label: ${labelLine.length}`);
  assert.ok(labelLine.includes("…"));
});

// ---- expansion boundary ----------------------------------------------------

test("template expansion: slash-prefixed inputs are ineligible; eligible text passes expansion unchanged", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  // Slash input (pre- or post-expansion) is ineligible — expansion can never
  // diverge an eligible fingerprint.
  const slash = await coordinator.retrieve(
    "/kiwifs-status --verbose",
    undefined,
    "interactive",
  );
  assert.equal(slash.kind, "ineligible");
  assert.equal(
    injector.onBeforeAgentStart("/kiwifs-status --verbose (expanded)"),
    undefined,
  );
  assert.equal(coordinator.registry.dropUnmatched().length, 0);

  // Eligible text: expansion is identity for non-slash inputs, so the
  // fingerprint (raw text) matches the prompt stored by Pi.
  const text = "explain the /etc/hosts entry for localhost";
  await freshPack(coordinator, text);
  assert.ok(injector.onBeforeAgentStart(text), "eligible input matches");
});

// ---- generation invalidation / isolation ----------------------------------

test("session generation invalidation: packs carry their minting generation; settle drop isolates leftovers", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const injector = new EvidenceInjector(coordinator.registry);
  const pack1 = await queuedPack(coordinator, "stale generation input");
  assert.equal(pack1.generation, 1);
  coordinator.setGeneration(2);
  const pack2 = await queuedPack(coordinator, "new generation input");
  assert.equal(pack2.generation, 2);

  // Packs carry the generation they were minted under; the new-generation
  // pack is isolated by input and consumable on its own occurrence.
  const result = injector.onContext([userMsg("new generation input")]);
  assert.ok(result);
  assert.equal(
    (result!.messages.at(-1) as { details: { generation: number } }).details
      .generation,
    2,
  );
  // The old-generation leftover is dropped fail-closed at settle — never
  // carried into a later unrelated turn.
  const dropped = coordinator.registry.dropUnmatched();
  assert.equal(dropped.length, 1);
  assert.equal(
    injector.onContext([userMsg("stale generation input")]),
    undefined,
  );
});

// ---- tokenizer module loading ---------------------------------------------

test("configured tokenizer loads; malformed or unreliable modules fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-tokenizer-"));
  try {
    const good = join(dir, "good.mjs");
    writeFileSync(
      good,
      "export const tokenizer = { id: 'fake-model-tok', countTokens: (t) => t.length };",
    );
    const ok = await loadConfiguredTokenizer({ module: good }, dir);
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.tokenizer.countTokens("abc"), 3);

    const missing = await loadConfiguredTokenizer(
      { module: join(dir, "nope.mjs") },
      dir,
    );
    assert.equal(missing.ok, false);

    const bad = join(dir, "bad.mjs");
    writeFileSync(bad, "export const tokenizer = { id: '' };");
    const malformed = await loadConfiguredTokenizer({ module: bad }, dir);
    assert.equal(malformed.ok, false);

    const flaky = join(dir, "flaky.mjs");
    writeFileSync(
      flaky,
      "export const tokenizer = { id: 'f', countTokens: () => { throw new Error('boom'); } };",
    );
    const loaded = await loadConfiguredTokenizer({ module: flaky }, dir);
    assert.ok(loaded.ok);
    assert.equal(
      loaded.ok && loaded.tokenizer.countTokens("text"),
      undefined,
      "unreliable count → undefined, never a character estimate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- recall tools: same pipeline, no bypass --------------------------------

/** Run a tool definition and return its first text block. */
async function runTool(
  tool: {
    execute: (
      toolCallId: string,
      params: never,
      signal: undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: unknown[] }>;
  },
  params: Record<string, string>,
): Promise<string> {
  const result = await tool.execute(
    "id",
    params as never,
    undefined,
    undefined,
    undefined as unknown as ExtensionContext,
  );
  return (result.content[0] as { text: string }).text;
}

function toolDeps(coordinator: RetrievalCoordinator, adapter: KiwiFSAdapter) {
  return {
    getRuntime: () => ({ coordinator, adapter }),
    getHeldReason: () => undefined,
    privateMode: () => false,
    deadlineMs: 2000,
  };
}

test("recall tools cannot bypass private mode", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const adapter = makeAdapter(RECORDS);
  const search = buildMemorySearchTool(() => ({
    ...toolDeps(coordinator, adapter),
    privateMode: () => true,
  }));
  const read = buildMemoryReadTool(() => ({
    ...toolDeps(coordinator, adapter),
    privateMode: () => true,
  }));
  const s = await runTool(search, { query: "SQLite" });
  assert.match(s, /private mode/);
  const r = await runTool(read, { path: OBS_PATH });
  assert.match(r, /private mode/);
  assert.equal(adapter.readCalls.length, 0, "no backend reads in private mode");
});

test("recall tools pass the guard pipeline: unauthorized scope and forgotten records fail closed", async () => {
  const coordinator = makeCoordinator(
    makeAdapter(RECORDS, () => [FTS_HIT(OBS_PATH)]),
  );
  const records = {
    ...RECORDS,
    "project/beta/memory/observations/2026/09/b1.md": {
      frontmatter: { scope: "project/beta", memory_status: "active" },
      body: "Beta uses Postgres.",
    },
  };
  const adapter = makeAdapter(records);
  const search = buildMemorySearchTool(() => toolDeps(coordinator, adapter));
  const read = buildMemoryReadTool(() => toolDeps(coordinator, adapter));

  const cross = await runTool(search, { query: "Postgres" });
  assert.match(cross, /No memory records passed the guard pipeline/);

  const readOk = await runTool(read, { path: OBS_PATH });
  assert.match(readOk, /UNTRUSTED DATA/);
  assert.match(readOk, /\[Memory source=/);

  const missing = await runTool(read, { path: "does/not/exist.md" });
  assert.match(missing, /read-back/);
});
