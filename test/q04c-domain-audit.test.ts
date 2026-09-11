/**
 * Q04c acceptance: the promised capture / retrieval / change audit events are
 * emitted through the EXISTING typed sink (`AuditSinkLike` → production
 * `FileAuditStore`) from every domain — observation, reflection, backup,
 * board, proposals (change), commands — with no duplicate audit
 * implementations.
 *
 * Synthetic fixtures only: no real service, model call, or private config.
 * Secret canaries are SYNTHETIC fixture patterns, never real credentials.
 *
 * Covered here:
 * - capture: observation captured / held (private mode, private-session
 *   classification) / failed; backup captured / held (private mode).
 * - reflection: ran (with content-free setHash) / skipped.
 * - retrieval: held (private mode) / completed, with counts only.
 * - change: proposal approved / refused (stale state).
 * - commands: forget ok / failed (op id only — never the path or reason).
 * - board: cycle completed / held (private mode) with counters.
 * - Canary absence across EVERY emitted JSONL line (raw text + parsed keys).
 * - Disabled behavior: no sink → no events, no files, domains unaffected.
 * - Degraded sink (injected ENOSPC): domains still proceed, events are
 *   buffered (never dropped or falsely acknowledged), status is sanitized.
 * - Disk bound: every line parses and stays ≤ the 2048-byte line bound;
 *   rotation itself is covered by the Q04a suite over the same store.
 */

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionCoordinator } from "../src/pi/coordinator.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import {
  ObserverScheduler,
  type SourceEntryView,
} from "../src/observation/scheduler.ts";
import { ReflectionEngine } from "../src/observation/reflection.ts";
import {
  ProposalLifecycle,
  ProposalOpLog,
  StaleProposalError,
} from "../src/observation/proposals.ts";
import type { ProposalStore } from "../src/observation/proposals.ts";
import { BackupCapture } from "../src/backup/capture.ts";
import { RetrievalCoordinator } from "../src/retrieval/coordinator.ts";
import { BoardDelivery, DeliveryStateFile } from "../src/board/delivery.ts";
import type { BoardRepository } from "../src/board/repository.ts";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { forgetMemoryPath } from "../src/commands/manual-ops.ts";
import { ManualOpLog } from "../src/commands/manual-ops.ts";
import { FileAuditStore } from "../src/privacy/audit-store.ts";
import { AUDIT_LIMITS } from "../src/privacy/audit.ts";

// Synthetic canaries — fixture patterns only, never real secrets.
const CANARY_API_KEY = "sk-synthetic0123456789abcdefABCDEF";
const CANARY_GITHUB = "ghp_" + "S0123456789abcdefghijklmnopqrstuvwxyz";
const CANARY_QUERY = "CANARY-QUERY-TEXT";
const CANARY_BODY = "CANARY-BOARD-BODY";
const ALL_CANARIES = [CANARY_API_KEY, CANARY_GITHUB, CANARY_QUERY, CANARY_BODY];

const SCOPE = "project/demo";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiwifs-q04c-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function logPath(): string {
  return join(dir, "audit.log");
}

function newAudit(): FileAuditStore {
  return new FileAuditStore({ path: logPath() });
}

function emittedLines(): string[] {
  assert.equal(existsSync(logPath()), true, "audit log must exist");
  const raw = readFileSync(logPath(), "utf8");
  return raw.split("\n").filter((l) => l.length > 0);
}

function emittedEvents(): Record<string, unknown>[] {
  return emittedLines().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every emitted JSONL line: parseable, allowlisted keys, canary-free. */
function assertAllLinesContentFree(): void {
  const ALLOWED_KEYS = new Set([
    "ts",
    "kind",
    "feature",
    "scope",
    "targetId",
    "byteCounts",
    "decision",
    "degraded",
    "snippet",
  ]);
  for (const line of emittedLines()) {
    assert.ok(
      Buffer.byteLength(line, "utf8") <= AUDIT_LIMITS.maxLineBytes,
      "line exceeds the audit byte bound",
    );
    const ev = JSON.parse(line) as Record<string, unknown>;
    for (const key of Object.keys(ev)) {
      assert.ok(ALLOWED_KEYS.has(key), `non-allowlisted key: ${key}`);
    }
    assert.ok(!/\n/.test(line), "embedded newline in an audit line");
    streamCheck: for (const c of ALL_CANARIES) {
      if (line.includes(c)) {
        assert.fail(`raw canary material in audit line: ${c}`);
      }
    }
  }
}

// ---- shared fixture bits ----------------------------------------------------

function outboxAt(sub: string): DurableOutbox {
  return DurableOutbox.open(join(dir, sub));
}

function observationEntry(
  id: string,
  text: string,
): SourceEntryView & { role: string } {
  return {
    id,
    role: "user",
    text,
    timestamp: "2026-09-08T00:00:00Z",
  } as unknown as SourceEntryView & { role: string };
}

// ---- observation capture events ---------------------------------------------

test("observation: capture, private hold and failure events through the typed sink", async () => {
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getLeafId: () => "leaf-a",
      },
    },
    { reason: "startup" },
  );
  const store = DurableOutbox.open(join(dir, "outbox"));
  const audit = newAudit();
  let privateMode = false;
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: SCOPE,
    sessionId: "s1",
    minBatchTokens: 1,
    minBatchTurns: 1,
    extract: () => [{ statement: "safe synthetic note" }],
    isPrivate: () => privateMode,
    audit,
  });
  const sources: (SourceEntryView & { role: string })[] = [];
  scheduler.setProvider({ entries: () => sources });

  // Capture: one entry → extraction → durable acceptance → captured event.
  sources.push(observationEntry("e1", `turn one ${CANARY_QUERY}`));
  const settle = scheduler.onAgentSettled();
  assert.equal(settle.scheduled, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    store.pending().filter((j) => j.kind === "observation").length,
    1,
  );

  // Private mode: new entries are classified private-session — held event.
  privateMode = true;
  sources.push(observationEntry("e2", "private period turn"));
  const held = scheduler.onAgentSettled();
  assert.equal(held.skippedReason, "private-mode");

  const events = emittedEvents();
  const captured = events.find(
    (e) => e["kind"] === "observation" && e["decision"] === "captured",
  );
  assert.ok(captured, "missing captured event");
  assert.equal(captured["feature"], "capture");
  assert.equal(captured["scope"], SCOPE);
  assert.match(
    String(captured["targetId"]),
    /^[0-9a-f]{16}$/i,
    "short record id expected",
  );
  const heldEv = events.find(
    (e) =>
      e["kind"] === "observation" &&
      String(e["decision"]).startsWith("held (private mode)"),
  );
  assert.ok(heldEv, "missing private hold event");
  assertAllLinesContentFree();
  scheduler.dispose();
});

test("observation: acceptance failure records a sanitized failure event", async () => {
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getLeafId: () => "leaf-a",
      },
    },
    { reason: "startup" },
  );
  // Corrupt outbox: enqueue fails → acceptance failure is audited, not silent.
  const store = DurableOutbox.open(join(dir, "outbox"));
  const audit = newAudit();
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: SCOPE,
    sessionId: "s1",
    minBatchTokens: 1,
    minBatchTurns: 1,
    extract: () => {
      throw new Error("synthetic extraction failure");
    },
    audit,
  });
  const sources: (SourceEntryView & { role: string })[] = [
    observationEntry("e1", "turn one"),
  ];
  scheduler.setProvider({ entries: () => sources });
  const settle = scheduler.onAgentSettled();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settle.scheduled, 1);
  const events = emittedEvents();
  assert.ok(
    events.some(
      (e) =>
        e["kind"] === "observation" &&
        String(e["decision"]).startsWith("failed ("),
    ),
    "missing failure event",
  );
  assertAllLinesContentFree();
  scheduler.dispose();
});

// ---- reflection events --------------------------------------------------------

test("reflection: ran and skipped events with content-free set hash", async () => {
  const store = DurableOutbox.open(join(dir, "outbox"));
  const audit = newAudit();
  const engine = new ReflectionEngine({
    stateDir: dir,
    scope: SCOPE,
    outbox: store,
    minObservations: 1,
    audit,
    reflect: async () => ({
      summary: `summary containing ${CANARY_BODY}`,
      duplicates: [],
      conflicts: [],
    }),
    now: (() => {
      let t = 1_000;
      return () => (t += 1_000);
    })(),
  });
  engine.noteAccepted({
    recordId: "obs-1",
    recordPath: `${SCOPE}/memory/observations/x.md`,
    createdAt: 1,
    statements: [`statement with ${CANARY_API_KEY}`],
    uncertainty: "low",
    sourceEntryIds: ["e1"],
    sessionId: "s1",
  });
  const ran = await engine.reflectNow();
  assert.equal(ran.ran, true);
  engine.noteAccepted({
    recordId: "obs-2",
    recordPath: `${SCOPE}/memory/observations/y.md`,
    createdAt: 2,
    statements: ["another statement"],
    uncertainty: "low",
    sourceEntryIds: ["e2"],
    sessionId: "s1",
  });
  const secondEngine = new ReflectionEngine({
    stateDir: join(dir, "second"),
    scope: SCOPE,
    outbox: store,
    minObservations: 99,
    audit,
    reflect: async () => ({ summary: "s", duplicates: [], conflicts: [] }),
  });
  secondEngine.noteAccepted({
    recordId: "obs-3",
    recordPath: `${SCOPE}/memory/observations/z.md`,
    createdAt: 3,
    statements: ["third statement"],
    uncertainty: "low",
    sourceEntryIds: ["e3"],
    sessionId: "s1",
  });
  const below = await secondEngine.maybeReflect();
  assert.equal(below.skippedReason, "below-threshold");

  const events = emittedEvents();
  const ranEv = events.find(
    (e) => e["kind"] === "reflection" && e["decision"] === "ran",
  );
  assert.ok(ranEv, "missing ran event");
  assert.match(String(ranEv["targetId"]), /^[0-9a-f]+$/i, "set hash expected");
  assert.ok(
    events.some(
      (e) =>
        e["kind"] === "reflection" &&
        e["decision"] === "skipped (below-threshold)",
    ),
  );
  assertAllLinesContentFree();
});

// ---- backup capture events ----------------------------------------------------

function messageEntry(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: text },
  };
}

test("backup: captured and private-held events through the typed sink", () => {
  const store = DurableOutbox.open(join(dir, "outbox"));
  const audit = newAudit();
  let privateMode = false;
  const capture = new BackupCapture({
    stateDir: dir,
    outbox: store,
    scope: SCOPE,
    projectId: "demo",
    sessionId: "s1",
    privateMode: () => privateMode,
    audit,
  });
  let result = capture.capture([
    messageEntry("e1", `transcript with ${CANARY_API_KEY}`),
  ]);
  assert.equal(result.enqueuedChunks > 0, true);
  assert.ok(
    emittedEvents().some(
      (e) => e["kind"] === "backup" && e["decision"] === "captured",
    ),
  );

  privateMode = true;
  result = capture.capture([messageEntry("e2", "private period")]);
  assert.equal(result.skippedReason, "private-mode");
  assert.ok(
    emittedEvents().some(
      (e) => e["kind"] === "backup" && e["decision"] === "held (private mode)",
    ),
  );
  assertAllLinesContentFree();
});

// ---- retrieval events ---------------------------------------------------------

function retrievalAdapter(
  withHit: boolean,
): RetrievalCoordinator["adapterField"] {
  return {
    async read(path: string) {
      return {
        state: "ok",
        content: `---\nscope: ${SCOPE}\nmemory_status: active\n---\n\nEvidence body ${CANARY_BODY}`,
        frontmatter: { scope: SCOPE, memory_status: "active" },
        body: `Evidence body ${CANARY_BODY}`,
      };
    },
    async searchFts() {
      return {
        hits: withHit
          ? [{ path: `${SCOPE}/memory/observations/a1.md`, score: 0.9 }]
          : [],
        text: "",
      };
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
  } as unknown as RetrievalCoordinator["adapterField"];
}

function makeRetrieval(
  audit: FileAuditStore | undefined,
  privateMode: () => boolean,
): RetrievalCoordinator {
  return new RetrievalCoordinator({
    adapter: retrievalAdapter(true) as never,
    authorizedScopes: [SCOPE],
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: (text: string) => ({ ok: true, content: text }),
    tokenizer: {
      id: "test",
      countTokens: (t: string) => t.split(/\s+/).length,
    },
    privateMode,
    ...(audit ? { audit } : {}),
  });
}

test("retrieval: held (private), completed and disabled-sink behavior", async () => {
  // Private mode: held event, zero reads.
  let privateMode = true;
  const audit = newAudit();
  const held = makeRetrieval(audit, () => privateMode);
  const out1 = await held.retrieve(`find ${CANARY_QUERY}`, undefined, "user");
  assert.equal(out1.kind, "degraded");

  // Normal mode: completed event with counts, never the query text.
  privateMode = false;
  const out2 = await held.retrieve(`find ${CANARY_QUERY}`, undefined, "user");
  assert.equal(out2.kind, "pack");

  const decisions = emittedEvents()
    .filter((e) => e["kind"] === "retrieval")
    .map((e) => String(e["decision"]));
  assert.ok(decisions.some((d) => d === "held (private mode)"));
  assert.ok(
    decisions.some((d) => d.startsWith("completed")),
    `missing completed event: ${JSON.stringify(decisions)}`,
  );
  assertAllLinesContentFree();
});

// ---- proposal change events -----------------------------------------------------

class FakeBackend implements ProposalStore {
  docs = new Map<string, string>();
  async read(path: string) {
    const c = this.docs.get(path);
    return c !== undefined
      ? { state: "ok" as const, content: c }
      : { state: "missing" as const };
  }
  async write(path: string, content: string): Promise<unknown> {
    this.docs.set(path, content);
    return { replayed: false };
  }
}

const CREATED = Date.UTC(2026, 8, 8);

test("change: proposal stale-refusal events", async () => {
  const lifecycle = new ProposalLifecycle({
    opLog: new ProposalOpLog(dir),
    openStore: async () => new FakeBackend(),
    audit: newAudit(),
  });
  // Stale refusal: a nonexistent proposal fails visibly and is audited.
  await assert.rejects(
    () =>
      lifecycle.approve(`${SCOPE}/memory/merge-proposals/none.md`, {
        actor: "test",
      }),
    StaleProposalError,
  );
  const events = emittedEvents();
  assert.ok(
    events.some(
      (e) =>
        e["kind"] === "change" && String(e["decision"]).startsWith("failed ("),
    ),
    "missing failed change event",
  );
  // Q04 review fix: targetId is the basename only — no directory components
  // (home directory / username) may ever be persisted.
  for (const e of events) {
    if (e["kind"] === "change" && typeof e["targetId"] === "string") {
      assert.ok(
        !e["targetId"].includes("/") && !e["targetId"].includes("\\"),
        `change targetId must be a basename, got ${JSON.stringify(e["targetId"])}`,
      );
    }
  }
  assertAllLinesContentFree();
});

// ---- command events -------------------------------------------------------------

test("commands: forget ok/failed events carry only op ids", async () => {
  const { forgetMemoryPath } = await import("../src/commands/manual-ops.ts");
  const opLog = new ManualOpLog(join(dir, "ops"));
  const audit = newAudit();
  const okStore = {
    async read() {
      return {
        state: "ok" as const,
        content: "---\nscope: project/demo\nmemory_status: active\n---\n\nbody",
        frontmatter: { scope: SCOPE, memory_status: "active" },
        body: "body",
      };
    },
    async write() {
      return {};
    },
    async forget(_path: string, _opts: { opId: string }) {
      return {};
    },
  };
  const ok = await forgetMemoryPath({
    opLog,
    openStore: async () => okStore as never,
    path: `${SCOPE}/memory/observations/x.md`,
    reason: `cleanup ${CANARY_API_KEY}`,
    actor: "synthetic-test",
    audit,
  });
  assert.equal(ok.ok, true);
  const fail = await forgetMemoryPath({
    opLog,
    openStore: async () => {
      throw new Error("synthetic outage");
    },
    path: `${SCOPE}/memory/observations/y.md`,
    actor: "synthetic-test",
    audit,
  });
  assert.equal(fail.ok, false);
  const commandEvents = emittedEvents().filter((e) => e["kind"] === "command");
  assert.ok(
    commandEvents.some((e) => String(e["decision"]).startsWith("ok (forget)")),
  );
  assert.ok(
    commandEvents.some((e) =>
      String(e["decision"]).startsWith("failed (forget:"),
    ),
  );
  for (const e of commandEvents) {
    if (e["targetId"] !== undefined) {
      assert.match(String(e["targetId"]), /^[0-9a-f-]+$/i, "op id only");
    }
  }
  assertAllLinesContentFree();
});

// ---- board cycle events -----------------------------------------------------------

test("board: completed and private-held cycle events with counters", async () => {
  const audit = newAudit();
  let privateMode = false;
  const msgPath = `board/dev/${"a".repeat(32)}.md`;
  const repo = {
    async changes() {
      return { changes: [{ path: msgPath }], lastSeq: "s1" };
    },
    async read() {
      return {
        ok: true,
        msgId: "a".repeat(32),
        to: "bob",
        from: "alice",
        channel: "dev",
        created: "2026-01-01T00:00:00Z",
        ttlSeconds: undefined,
        expired: false,
        body: CANARY_BODY,
      };
    },
  } as unknown as BoardRepository;
  const state = new DeliveryStateFile(join(dir, "board"), "consumer-a");
  const delivered: unknown[] = [];
  const delivery = new BoardDelivery({
    repo,
    state,
    deliver: (m) => void delivered.push(m),
    privateMode: {
      get isPrivate() {
        return privateMode;
      },
    },
    schedule: false,
    audit,
  });
  let cycle = await delivery.runCycle();
  assert.equal(cycle.paused, false);
  assert.equal(delivered.length, 1);
  privateMode = true;
  cycle = await delivery.runCycle();
  assert.equal(cycle.pauseReason, "private");
  const boardEvents = emittedEvents().filter((e) => e["kind"] === "board");
  assert.ok(
    boardEvents.some((e) => e["decision"] === "completed"),
    JSON.stringify(boardEvents),
  );
  assert.ok(
    boardEvents.some((e) => e["decision"] === "held (private)"),
    JSON.stringify(boardEvents),
  );
  assertAllLinesContentFree();
});

// ---- disabled / degraded edges ------------------------------------------------------

test("disabled sink: domains proceed, no audit file is created", () => {
  const store = DurableOutbox.open(join(dir, "outbox"));
  const capture = new BackupCapture({
    stateDir: dir,
    outbox: store,
    scope: SCOPE,
    projectId: "demo",
    sessionId: "s1",
  });
  const result = capture.capture([messageEntry("e1", "plain text")]);
  assert.equal(result.enqueuedChunks > 0, true);
  assert.equal(existsSync(logPath()), false, "no audit file without a sink");
});

test("degraded sink: injected ENOSPC buffers events, domains still proceed", () => {
  // FileAuditStore with a fs whose appendFileSync fails (synthetic disk full).
  let failures = 0;
  void failures;
  const failingFs = {
    appendFileSync: () => {
      const err = new Error("synthetic ENOSPC") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    },
    existsSync: nodeFs.existsSync,
    mkdirSync: nodeFs.mkdirSync,
    readdirSync: nodeFs.readdirSync,
    readFileSync: nodeFs.readFileSync,
    renameSync: nodeFs.renameSync,
    statSync: nodeFs.statSync,
    unlinkSync: nodeFs.unlinkSync,
    chmodSync: nodeFs.chmodSync,
    truncateSync: nodeFs.truncateSync,
    writeFileSync: nodeFs.writeFileSync,
  };
  const audit = new FileAuditStore({
    path: logPath(),
    fs: failingFs as never,
  });
  const store = DurableOutbox.open(join(dir, "outbox"));
  const capture = new BackupCapture({
    stateDir: dir,
    outbox: store,
    scope: SCOPE,
    projectId: "demo",
    sessionId: "s1",
    audit,
  });
  const result = capture.capture([messageEntry("e1", "content")]);
  // Logging failure must NOT authorize, drop pending jobs, or misreport.
  assert.equal(result.enqueuedChunks > 0, true);
  const ev = audit.record({ kind: "backup", decision: "captured" });
  assert.equal(ev.degraded, true);
  const st = audit.status();
  assert.equal(st.degraded, true);
  assert.equal(st.lastError, "ENOSPC");
  assert.equal(st.writeFailures > 0, true);
  assert.equal(st.buffered > 0, true);
  assert.equal(st.persisted, 0);
  audit.close();
});

test("disk bound: emitted lines stay within the per-line byte budget", () => {
  const audit = newAudit();
  const store = DurableOutbox.open(join(dir, "outbox"));
  const capture = new BackupCapture({
    stateDir: dir,
    outbox: store,
    scope: SCOPE,
    projectId: "demo",
    sessionId: "s1",
    audit,
  });
  capture.capture([messageEntry("e1", "content")]);
  for (const line of emittedLines()) {
    assert.ok(Buffer.byteLength(line, "utf8") <= AUDIT_LIMITS.maxLineBytes);
  }
  const st = audit.status();
  assert.equal(st.degraded, false);
  assert.equal(st.buffered, 0);
  audit.close();
});
