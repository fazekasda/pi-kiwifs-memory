/**
 * T12: fixture 11 — Pi 0.85.0 ordering and matched injection
 * (docs/research/mcp-contracts.md §9 fixture 11, architecture.md §3.1,
 * PRD T12 AC 1–2).
 *
 * The harness below reproduces the VERIFIED Pi 0.85.0 event ordering that
 * this fixture exists to pin (citations from docs/research/mcp-contracts.md
 * §6, checked against the installed package):
 *
 * - `emitInput` is awaited inside prompt submission BEFORE skill/template
 *   expansion and before agent start, for fresh and queued inputs alike
 *   (agent-session.js:841–854) — so the awaited `input` handler completes a
 *   retrieval cycle before the first provider call.
 * - Queued steer/followUp inputs are stored and replayed by Pi as EXPANDED
 *   text (agent-session.js:853–868); the raw input text observed by the
 *   `input` event is pre-expansion. Eligible (non-slash) inputs pass through
 *   expansion unchanged; slash-prefixed inputs are ineligible for retrieval,
 *   so expansion can never diverge an eligible fingerprint.
 * - `before_agent_start` fires only inside `prompt()` (agent-session.js:914–932):
 *   a steered/followUp input gets NO new before_agent_start, and a followUp
 *   may begin a new agent run — still without one.
 * - The `context` event fires per provider request (types.d.ts:514–516),
 *   including tool loops — injection must therefore match the CONSUMED input
 *   (last user message fingerprint + occurrence guard), not merely the next
 *   fire, and dedupe by inputId.
 * - `agent_settled` marks the end of a run; unmatched packs are dropped
 *   fail-closed there, never carried into a later turn.
 *
 * The harness's context-injector step calls PendingPackRegistry
 * .consumeMatching on every context fire — the same matching engine the T13
 * context-injector wiring will use. Scenarios cover: fresh ordering (AC 1),
 * steer-queued matched injection on the consuming provider call, unmatched
 * pack dropped at settle (AC 2), redaction-active fingerprinting, and the
 * template-expanded queued variant.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import {
  PendingPackRegistry,
  RetrievalCoordinator,
  fingerprintInput,
} from "../src/retrieval/coordinator.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import { createRedactor } from "../src/privacy/redaction.ts";

// ---- Pi-ordering harness (simulation of verified agent-session.js flow) --

interface InputOptions {
  streamingBehavior?: "steer" | "followUp";
  source?: string;
}

type Handlers = Map<string, ((...args: never[]) => unknown)[]>;

class FakePiSession {
  private readonly handlers: Handlers = new Map();
  messages: AgentMessage[] = [];
  isStreaming = false;
  /** Ordered observable event trace. */
  trace: string[] = [];
  /** inputId fingerprints of packs injected per provider call. */
  injectedPerCall: (string | null)[] = [];
  /** Public for test control (queue manipulation in orphan-steer test). */
  queue: { text: string; behavior: "steer" | "followUp" }[] = [];
  private registry: PendingPackRegistry;
  /** Deterministic run gate: holds provider calls until released. */
  private gate: Promise<void> = Promise.resolve();
  private releaseRun: (() => void) | undefined;

  constructor(registry: PendingPackRegistry) {
    this.registry = registry;
  }

  /** Hold the in-flight run before its provider calls (test control). */
  holdRun(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseRun = resolve;
    });
  }

  release(): void {
    this.releaseRun?.();
  }

  on(event: string, handler: (...args: never[]) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  private async emit(event: string, ...args: unknown[]): Promise<unknown> {
    let result: unknown;
    for (const h of this.handlers.get(event) ?? []) {
      result = await (h as (...a: unknown[]) => unknown)(...args);
    }
    return result;
  }

  /** Expand skill commands / prompt templates — identity for non-slash text. */
  private static expand(text: string): string {
    return text;
  }

  /**
   * Verified prompt submission flow: emitInput (awaited, pre-expansion) →
   * expansion → queue (steer/followUp) or agent run.
   */
  async submit(text: string, opts: InputOptions = {}): Promise<void> {
    // Decide run-vs-queue SYNCHRONOUSLY (before awaiting the input handler):
    // the steering input is submitted while the fresh run is in flight, and
    // the run/streaming state must be observable to it deterministically —
    // not raced against the awaited retrieval in the input handler.
    const willRun = !this.isStreaming;
    if (willRun) this.isStreaming = true;
    // agent-session.js:841–854 — input event first, pre-expansion, awaited.
    await this.emit("input", {
      text,
      source: opts.source ?? "interactive",
      streamingBehavior: opts.streamingBehavior,
    });
    const expanded = FakePiSession.expand(text);
    if (!willRun) {
      const behavior = opts.streamingBehavior ?? "followUp";
      // agent-session.js:853–868 — the EXPANDED text is queued/stored.
      this.queue.push({ text: expanded, behavior });
      return;
    }
    await this.run(expanded);
  }

  /** One agent run: before_agent_start → provider calls → agent_settled. */
  async run(firstUserText: string): Promise<void> {
    this.trace.push("before_agent_start");
    await this.emit("before_agent_start", { prompt: firstUserText });
    this.messages.push(userMsg(firstUserText));
    await this.providerCalls();
    // Drain queued steer/followUp inputs as the loop continues (verified:
    // queued inputs are consumed by subsequent provider calls, with no new
    // before_agent_start).
    let guard = 0;
    while (this.queue.length > 0 && guard < 5) {
      guard += 1;
      const next = this.queue.shift()!;
      this.trace.push("drain-queued");
      this.messages.push(userMsg(next.text));
      await this.providerCalls();
    }
    this.isStreaming = false;
    this.trace.push("agent_settled");
    // Unmatched pending packs fail closed at run settle (dropped, visible).
    this.registry.dropUnmatched();
    await this.emit("agent_settled", {});
  }

  /** Provider call: context event → before_provider_request. */
  private async providerCalls(): Promise<void> {
    await this.gate;
    const consume = this.registry.consumeMatching(this.messages);
    const injected = consume.matched ? consume.pack.inputId : null;
    this.injectedPerCall.push(injected);
    this.trace.push("context");
    this.trace.push("before_provider_request");
    await this.emit("context", { messages: this.messages });
    await this.emit("before_provider_request", { payload: {} });
  }
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

interface FakeBackendShape {
  calls: { tool: string; args: Record<string, unknown> }[];
}

function makeBackend(): {
  adapter: KiwiFSAdapter & FakeBackendShape;
  backend: FakeBackendShape;
} {
  const calls: FakeBackendShape["calls"] = [];
  const record = {
    "project/alpha/memory/observations/2026/09/a1.md": {
      frontmatter: { scope: "project/alpha", memory_status: "active" },
      body: "Alpha uses SQLite for the search index.",
    },
  };
  const adapter = {
    calls,
    async read(path: string) {
      calls.push({ tool: "kiwi_read", args: { path } });
      const r = record[path as keyof typeof record];
      return r
        ? {
            state: "ok",
            content: "c",
            frontmatter: r.frontmatter,
            body: r.body,
          }
        : { state: "missing", frontmatter: {}, body: "" };
    },
    async searchFts(query: string, o: { scope?: string } = {}) {
      calls.push({ tool: "kiwi_search", args: { query, scope: o.scope } });
      return {
        hits: o.scope
          ? [
              {
                path: "project/alpha/memory/observations/2026/09/a1.md",
                score: 2,
              },
            ]
          : [],
        text: "",
      };
    },
    async searchSemantic() {
      calls.push({ tool: "kiwi_search_semantic", args: {} });
      return { hits: [], text: "" };
    },
    async searchHybrid() {
      calls.push({ tool: "kiwi_search_hybrid", args: {} });
      return { hits: [], degraded: false, text: "" };
    },
    async brief() {
      calls.push({ tool: "kiwi_brief", args: {} });
      return { sections: [], dropped: [], text: "" };
    },
  } as unknown as KiwiFSAdapter & FakeBackendShape;
  return { adapter, backend: { calls } };
}

function makeSession(coordinator: RetrievalCoordinator): FakePiSession {
  const session = new FakePiSession(coordinator.registry);
  // The input handler awaits retrieval before returning (verified ordering):
  // one logical retrieval cycle per eligible input, evidence exists before
  // the first before_provider_request.
  session.on("input", async (event: unknown) => {
    const e = event as { text: string; source?: string };
    session.trace.push(`input:${JSON.stringify(e.text)}`);
    await coordinator.retrieve(
      e.text,
      (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior,
      e.source ?? "interactive",
    );
  });
  return session;
}

const TOKENIZER = {
  id: "test",
  countTokens: (t: string) => t.split(/\s+/).filter(Boolean).length,
};

test("AC1: fresh input — retrieval completes before the first before_provider_request; one logical cycle", async () => {
  const { adapter } = makeBackend();
  const coordinator = new RetrievalCoordinator({
    adapter,
    authorizedScopes: ["project/alpha"],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: TOKENIZER,
  });
  const session = makeSession(coordinator);
  await session.submit("what did alpha decide about the index?");
  // Evidence precedes the first provider request (AC 1).
  const firstContext = session.trace.indexOf("context");
  assert.ok(
    session.trace.indexOf("input:") < firstContext,
    `trace: ${session.trace.join(" -> ")}`,
  );
  assert.match(session.trace[0]!, /^input:/);
  assert.ok(firstContext > 0);
  // Exactly one retrieval cycle: one FTS + one semantic call for the scope.
  assert.equal(adapter.calls.filter((c) => c.tool === "kiwi_search").length, 1);
  assert.equal(
    adapter.calls.filter((c) => c.tool === "kiwi_search_semantic").length,
    1,
  );
  // The fresh pack was consumed on the first (and only) provider call.
  assert.equal(session.injectedPerCall.length, 1);
  assert.notEqual(session.injectedPerCall[0], null);
});

test("AC2 (fixture 11): steer-queued input gets its own cycle; pack injects on the CONSUMING provider call, not the next fire", async () => {
  const { adapter } = makeBackend();
  const coordinator = new RetrievalCoordinator({
    adapter,
    authorizedScopes: ["project/alpha"],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: TOKENIZER,
  });
  const session = makeSession(coordinator);
  // Fresh turn starts streaming, held before its provider calls…
  session.holdRun();
  const runPromise = session.submit("start working on the index");
  // …and a steer input arrives mid-stream (deterministically before release).
  await session.submit("also check the sqlite scope", {
    streamingBehavior: "steer",
  });
  session.release();
  await runPromise;

  // Two retrieval cycles (one per input event): 2 FTS calls.
  assert.equal(adapter.calls.filter((c) => c.tool === "kiwi_search").length, 2);
  // No new before_agent_start for the steered input (verified Pi behavior):
  assert.equal(
    session.trace.filter((t) => t === "before_agent_start").length,
    1,
  );
  // First provider call: only the fresh input was consumed — the steered
  // pack must NOT be injected merely because a context fire happens.
  const freshPackId = fingerprintInput("start working on the index", undefined);
  const steerPackId = fingerprintInput("also check the sqlite scope", "steer");
  assert.equal(session.injectedPerCall[0], freshPackId);
  // Second provider call consumes the steered input (drain-queued first):
  assert.equal(session.injectedPerCall[1], steerPackId);
  assert.equal(session.trace.filter((t) => t === "drain-queued").length, 1);
  // Nothing left pending; nothing dropped.
  assert.equal(coordinator.registry.pendingCount, 0);
});

test("AC2: unmatched steer pack fails closed — dropped at run settle, never carried into a later turn", async () => {
  const { adapter } = makeBackend();
  const coordinator = new RetrievalCoordinator({
    adapter,
    authorizedScopes: ["project/alpha"],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: TOKENIZER,
  });
  const session = makeSession(coordinator);
  // Steer arrives while the run is held; the queue is then removed (the run
  // settles WITHOUT ever consuming the steered input).
  session.holdRun();
  const runPromise = session.submit("begin");
  await session.submit("orphan steer", { streamingBehavior: "steer" });
  session.queue.length = 0;
  session.release();
  await runPromise;
  // Both retrieval cycles ran (fresh + steer), but the steer pack was never
  // injected.
  assert.equal(adapter.calls.filter((c) => c.tool === "kiwi_search").length, 2);
  assert.notEqual(
    session.injectedPerCall[0],
    fingerprintInput("orphan steer", "steer"),
  );
  // After settle, a later unrelated turn cannot consume the dropped pack.
  await session.submit("a later unrelated turn");
  const laterCall = session.injectedPerCall.at(-1);
  assert.equal(
    laterCall,
    fingerprintInput("a later unrelated turn", undefined),
  );
  assert.notEqual(laterCall, fingerprintInput("orphan steer", "steer"));
});

test("fixture 11 redaction-active variant: fingerprint uses RAW text; outbound queries are redacted", async () => {
  const { adapter, backend } = makeBackend();
  const secret = "sk-synthetic0123456789abcdefghijklmnopqrst";
  const coordinator = new RetrievalCoordinator({
    adapter,
    authorizedScopes: ["project/alpha"],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    // Real T06 redactor: patterns + entropy; the secret is synthetic.
    redact: createRedactor(),
    tokenizer: TOKENIZER,
  });
  const session = makeSession(coordinator);
  const raw = `check the ${secret} deployment`;
  await session.submit(raw);
  // Outbound queries must not carry the secret…
  for (const call of backend.calls) {
    const q = (call.args["query"] as string | undefined) ?? "";
    assert.ok(!q.includes(secret), "secret leaked into an outbound query");
  }
  // …yet the pack matches the RAW (unredacted) input text.
  assert.equal(session.injectedPerCall[0], fingerprintInput(raw, undefined));
});

test("fixture 11 template-expanded queued variant: slash inputs are ineligible; eligible expansion is identity", async () => {
  const { adapter } = makeBackend();
  const coordinator = new RetrievalCoordinator({
    adapter,
    authorizedScopes: ["project/alpha"],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: TOKENIZER,
  });
  const session = makeSession(coordinator);
  // Slash-prefixed queued input: subject to template/skill expansion, hence
  // INELIGIBLE for retrieval — no pack exists, so expansion cannot diverge.
  await session.submit("/template-name arg", { streamingBehavior: "steer" });
  assert.equal(adapter.calls.filter((c) => c.tool === "kiwi_search").length, 0);
  // Eligible non-slash queued text: expansion is identity, fingerprint holds.
  const runPromise = session.submit("fresh question");
  await new Promise((r) => setTimeout(r, 5));
  await session.submit("queued follow-up detail", {
    streamingBehavior: "followUp",
  });
  await runPromise;
  // Provider call ordering: [0] template run (no pack, no injection),
  // [1] "fresh question" consumes its own pack, [2] the queued follow-up
  // consumes its pack (expansion is identity for eligible text).
  assert.equal(
    session.injectedPerCall[1],
    fingerprintInput("fresh question", undefined),
  );
  assert.equal(
    session.injectedPerCall[2],
    fingerprintInput("queued follow-up detail", "followUp"),
  );
  assert.equal(coordinator.registry.pendingCount, 0);
});
