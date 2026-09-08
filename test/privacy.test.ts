/**
 * T06 acceptance tests: the privacy gate — redaction engine, exclusion
 * rules, private mode, sanitized audit events — against synthetic fixtures
 * only (fixtures/privacy/*). No live service is contacted.
 *
 * Acceptance coverage:
 * 1. Synthetic secret fixtures never appear in outbound payloads, queue
 *    bytes, logs or error messages.
 * 2. Private mode suppresses network reads/writes and new capture/backup/
 *    board jobs.
 * 3. Enabling private mode prevents pending jobs from sending; resume is
 *    explicit and releases held jobs (approved policy, architecture.md
 *    §13 row 21).
 * 4. Exclusion rules cover project, path and content patterns.
 * 5. Fail-closed: unclassifiable content is held, never sent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createRedactor,
  looksSecretBearing,
  redactText,
  shannonEntropy,
} from "../src/privacy/redaction.ts";
import {
  compileExclusions,
  isExcluded,
  type ExclusionRule,
} from "../src/privacy/exclusions.ts";
import {
  PrivateModeActiveError,
  PrivateModeGate,
} from "../src/privacy/private-mode.ts";
import { AuditSink } from "../src/privacy/audit.ts";
import { guardCandidate } from "../src/backend/guard.ts";
import { createFakeServer } from "./fake-mcp-server.ts";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger } from "../src/backend/opid.ts";
import { validateConfig } from "../src/config/schema.ts";
import {
  resolvedStatusLines,
  statusIsSecretFree,
} from "../src/config/status.ts";

const ENDPOINT = "https://kiwifs.test/mcp";

interface SecretSample {
  type: string;
  value: string;
}
const SECRET_SAMPLES: { secrets: SecretSample[]; benign: string[] } =
  JSON.parse(
    readFileSync(
      new globalThis.URL(
        "./fixtures/privacy/secret-samples.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const REDACTION_CASES: {
  cases: { name: string; input: string; expectTypes: string[] }[];
} = JSON.parse(
  readFileSync(
    new globalThis.URL(
      "./fixtures/privacy/redaction-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const EXCLUSION_CASES: {
  cases: {
    name: string;
    rules: ExclusionRule[];
    context: { scope?: string; path?: string; content?: string };
    expectExcluded?: boolean;
    expectError?: boolean;
  }[];
} = JSON.parse(
  readFileSync(
    new globalThis.URL(
      "./fixtures/privacy/exclusion-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function assertSecretFree(text: string, label: string): void {
  for (const secret of SECRET_SAMPLES.secrets) {
    assert.ok(
      !text.includes(secret.value),
      `${label} contains the synthetic ${secret.type} secret`,
    );
  }
  assert.ok(
    !looksSecretBearing(text),
    `${label} still looks secret-bearing: ${text}`,
  );
}

test("every synthetic secret fixture is redacted from the redactor output", () => {
  for (const secret of SECRET_SAMPLES.secrets) {
    const embedded = `context before ${secret.value} context after`;
    const result = redactText(embedded);
    assert.ok(
      result.ok,
      `redaction of ${secret.type} failed: ${JSON.stringify(result)}`,
    );
    assertSecretFree(result.content, `redacted ${secret.type}`);
    assert.ok(
      result.findings.length >= 1,
      `${secret.type} produced no finding`,
    );
    assert.ok(
      result.content.includes("[REDACTED:"),
      `${secret.type} replacement is not structural`,
    );
  }
});

test("redaction fixture cases produce the expected finding types", () => {
  for (const c of REDACTION_CASES.cases) {
    const result = redactText(c.input);
    assert.ok(
      result.ok,
      `case '${c.name}' held unexpectedly: ${JSON.stringify(result)}`,
    );
    const types = new Set(result.findings.map((f) => f.type));
    for (const expected of c.expectTypes) {
      assert.ok(
        types.has(expected),
        `case '${c.name}' missing finding type ${expected}`,
      );
    }
    assertSecretFree(result.content, `case '${c.name}' output`);
  }
});

test("queue bytes built from redacted payloads carry no secret material", () => {
  // Simulated sanitized outbox payload: content redacted at the privacy gate
  // BEFORE persistence (T07 wires the durable queue onto this shape).
  for (const secret of SECRET_SAMPLES.secrets) {
    const rawPayload = {
      kind: "observation",
      scope: "project/demo-proj",
      payload: { content: `user said: ${secret.value}` },
    };
    const redacted = redactText(rawPayload.payload.content);
    assert.ok(redacted.ok);
    const queueBytes = JSON.stringify({
      ...rawPayload,
      payload: { content: redacted.content },
    });
    assertSecretFree(queueBytes, `queue bytes for ${secret.type}`);
  }
});

test("audit sink default is metadata-only and secret-free", () => {
  const sink = new AuditSink();
  sink.record({
    kind: "outbound-write",
    feature: "observation",
    scope: "project/demo-proj",
    targetId: "memory/2026/09/abc.md",
    byteCounts: { payload: 512 },
    decision: "allowed",
  });
  const lines = sink.lines_so_far();
  assert.equal(lines.length, 1);
  assert.ok(
    !lines[0]!.includes("snippet"),
    "metadata-only events must have no snippet",
  );
  assertSecretFree(lines[0]!, "audit line");
});

test("audit snippets only at enabled verbosity and only after redaction", () => {
  const secret = SECRET_SAMPLES.secrets[0]!.value;
  const sink = new AuditSink({ verbosity: "snippets" });
  const event = sink.record({
    kind: "outbound-write",
    decision: "allowed",
    snippet: `payload start ${secret} payload end`,
  });
  assert.ok(event.snippet !== undefined);
  assertSecretFree(event.snippet ?? "", "audit snippet");
  assertSecretFree(sink.lines_so_far()[0]!, "audit line");
});

test("unclassifiable snippet is withheld from the audit log", () => {
  const sink = new AuditSink({ verbosity: "snippets" });
  const event = sink.record({
    kind: "outbound-write",
    decision: "allowed",
    snippet: "binary\u0000\u0001\u0002 content",
  });
  assert.equal(event.snippet, undefined);
  assert.ok(event.decision.includes("snippet withheld"));
});

test("audit line failing the secret-free post-check is suppressed, never persisted", () => {
  // An attacker-crafted targetId that itself looks like a long token must not
  // be able to smuggle opaque bytes into the audit log.
  const sink = new AuditSink();
  const rawTargetId = `${"A".repeat(40)}=${SECRET_SAMPLES.secrets[0]!.value}`;
  const event = sink.record({
    kind: "outbound-write",
    decision: "allowed",
    targetId: rawTargetId,
  });
  const line = sink.lines_so_far()[0]!;
  assert.equal(event.decision.startsWith("audit-suppressed"), true);
  assert.ok(
    !line.includes(rawTargetId),
    "suppressed line kept the raw targetId",
  );
  assertSecretFree(line, "suppressed audit line");
});

test("private mode suppresses network reads/writes and new capture jobs", () => {
  const gate = new PrivateModeGate();
  gate.enable();
  assert.throws(
    () => gate.assertNetworkAllowed("observation"),
    PrivateModeActiveError,
  );
  assert.throws(() => gate.assertNetworkAllowed(), PrivateModeActiveError);
  assert.throws(
    () => gate.assertNetworkAllowed("backup"),
    PrivateModeActiveError,
  );
  assert.throws(
    () => gate.assertNetworkAllowed("board"),
    PrivateModeActiveError,
  );
  assert.throws(
    () => gate.assertCaptureAllowed("observation"),
    PrivateModeActiveError,
  );
  assert.throws(
    () => gate.assertCaptureAllowed("backup"),
    PrivateModeActiveError,
  );
  assert.throws(
    () => gate.assertCaptureAllowed("board"),
    PrivateModeActiveError,
  );
});

test("private mode error messages never carry user content", () => {
  const gate = new PrivateModeGate();
  gate.enable();
  try {
    gate.assertNetworkAllowed("observation");
    assert.fail("expected throw");
  } catch (err) {
    assertSecretFree((err as Error).message, "private-mode error message");
  }
});

test("enabling private mode holds pending jobs; resume is explicit and releases them", () => {
  const gate = new PrivateModeGate();
  const accepted = gate.holdWhilePrivate({ opId: "op-1", kind: "observation" });
  assert.equal(accepted.held, false, "non-private mode does not hold jobs");

  gate.enable();
  const held = gate.holdWhilePrivate({ opId: "op-2", kind: "backup" });
  assert.equal(held.held, true);
  assert.equal(gate.heldJobs().length, 1);
  assert.throws(
    () => gate.assertNetworkAllowed("board"),
    PrivateModeActiveError,
  );

  const released: string[] = [];
  gate.onRelease((jobs) => {
    for (const job of jobs) released.push(job.opId);
  });
  gate.resume();
  assert.equal(gate.isPrivate, false);
  assert.deepEqual(released, ["op-2"], "resume releases exactly the held jobs");
  assert.equal(gate.heldJobs().length, 0);
  // Transition events are visible.
  const actions = gate.eventLog().map((e) => e.action);
  assert.deepEqual(actions, ["enabled", "resumed"]);
});

test("resume does not drop held jobs even when no listener is attached", () => {
  const gate = new PrivateModeGate();
  gate.enable();
  gate.holdWhilePrivate({ opId: "op-3", kind: "board" });
  gate.resume();
  assert.equal(
    gate.eventLog().at(-1)?.heldJobs,
    1,
    "resume event records the released count",
  );
});

test("exclusion fixture cases behave as expected", () => {
  for (const c of EXCLUSION_CASES.cases) {
    const compiled = compileExclusions(c.rules);
    if (c.expectError) {
      assert.ok(!compiled.ok, `case '${c.name}' should be a validation error`);
      continue;
    }
    assert.ok(compiled.ok, `case '${c.name}' should compile`);
    const check = isExcluded(c.context, compiled.compiled);
    assert.ok(check.ok);
    assert.equal(
      check.excluded,
      c.expectExcluded === true,
      `case '${c.name}' excluded=${check.excluded}`,
    );
  }
});

test("exclusion by project, path and content pattern (PRD criterion)", () => {
  const compiled = compileExclusions([
    { project: "project/secret-proj" },
    { pathPrefix: "personal/memory/vendor/" },
    { pattern: "\\bNDA-[0-9]{4}\\b" },
  ]);
  assert.ok(compiled.ok);
  for (const ctx of [
    { scope: "project/secret-proj", content: "innocuous" },
    { path: "personal/memory/vendor/x.md", content: "innocuous" },
    { content: "see NDA-1234" },
  ]) {
    const check = isExcluded(ctx, compiled.compiled);
    assert.ok(check.ok && check.excluded, JSON.stringify(ctx));
  }
});

test("config validates privacy.exclusions and status stays secret-free", () => {
  const good = validateConfig({
    schemaVersion: 1,
    enabled: false,
    privacy: {
      exclusions: [
        { project: "project/secret-proj" },
        { pathPrefix: "personal/memory/vendor/" },
        { pattern: "\\bNDA-[0-9]{4}\\b" },
      ],
    },
  });
  assert.ok(good.ok);
  assert.equal(good.config?.privacy.exclusions.length, 3);

  for (const bad of [
    { schemaVersion: 1, privacy: { exclusions: [{}] } },
    { schemaVersion: 1, privacy: { exclusions: [{ bogus: 1 }] } },
    { schemaVersion: 1, privacy: { exclusions: "nope" } },
  ]) {
    const result = validateConfig(bad);
    assert.ok(!result.ok, JSON.stringify(bad));
  }
  // An invalid regex source passes schema SHAPE validation but is rejected
  // (fail closed) by compileExclusions before any capture uses it.
  const shapeOk = validateConfig({
    schemaVersion: 1,
    privacy: { exclusions: [{ pattern: "(unclosed" }] },
  });
  assert.ok(shapeOk.ok);
  const compiled = compileExclusions(shapeOk.config!.privacy.exclusions);
  assert.ok(
    !compiled.ok,
    "invalid regex must fail closed in compileExclusions",
  );

  const lines = resolvedStatusLines(good.config!);
  assert.ok(lines.some((l) => l.includes("privacy exclusions: 3 rule(s)")));
  assert.equal(statusIsSecretFree(lines), true);
});

test("redaction fails closed on unclassifiable content (held, not sent)", async () => {
  const result = redactText("payload\u0000with NUL bytes\u0001");
  assert.ok(!result.ok);
  assert.equal(result.held, true);
  // Guard step 5 rejects held content.
  const server = createFakeServer();
  server.state.store.set(
    "project/demo-proj/memory/2026/09/x.md",
    "---\nscope: project/demo-proj\n---\nbody\u0000",
  );
  const adapter = new KiwiFSAdapter({
    url: ENDPOINT,
    ledger: createMemoryLedger(),
    fetchImpl: server.fetch,
  });
  await adapter.connect();
  const guarded = await guardCandidate(
    "project/demo-proj/memory/2026/09/x.md",
    {
      adapter,
      authorizedScopes: ["project/demo-proj"],
      redact: createRedactor(),
    },
  );
  assert.equal(guarded.ok, false);
  assert.equal(guarded.step, "redaction");
});

test("guard step 5 with the real T06 redactor strips secrets from injected records", async () => {
  const secret = SECRET_SAMPLES.secrets[1]!.value;
  const server = createFakeServer();
  server.state.store.set(
    "project/demo-proj/memory/2026/09/y.md",
    `---\nscope: project/demo-proj\n---\nDeploy used ${secret} today.`,
  );
  const adapter = new KiwiFSAdapter({
    url: ENDPOINT,
    ledger: createMemoryLedger(),
    fetchImpl: server.fetch,
  });
  await adapter.connect();
  const guarded = await guardCandidate(
    "project/demo-proj/memory/2026/09/y.md",
    {
      adapter,
      authorizedScopes: ["project/demo-proj"],
      redact: createRedactor(),
    },
  );
  assert.ok(guarded.ok);
  assertSecretFree(guarded.body, "guarded record body");
  assert.ok(guarded.body.includes("[REDACTED:"));
});

test("entropy heuristic: threshold and minimum length behavior", () => {
  assert.ok(
    shannonEntropy("aaaaaaaaaaaaaaaaaaaaaaaa") < 1,
    "low-diversity run is low entropy",
  );
  assert.ok(shannonEntropy(SECRET_SAMPLES.secrets[9]!.value) >= 4.0);
  // Below the minimum length, a high-entropy run is left alone.
  const shortToken = "Zm8qX9dL2wQe7Rt5vNh"; // 19 chars
  const result = redactText(`see ${shortToken} for details`);
  assert.ok(result.ok);
  assert.equal(result.findings.length, 0, "short token must not be flagged");
});

test("redactor internal fault holds content instead of passing it through", () => {
  // A pattern whose exec throws simulates a scanner fault.
  const bomb: { type: string; regex: RegExp } = {
    type: "boom",
    regex: /never/ as RegExp,
  };
  Object.defineProperty(bomb.regex, "exec", {
    value: () => {
      throw new Error("boom");
    },
  });
  const result = redactText("harmless words", { patterns: [bomb] });
  assert.ok(!result.ok);
  assert.equal(result.held, true);
  assertSecretFree((result as { reason: string }).reason, "hold reason");
});

// T06 review regressions (B1, B2)

test("looksSecretBearing does not flag UUIDs (B2 regression)", () => {
  const targetId = "550e8400-e29b-41d4-b892-0b4ba1a1f4c2";
  const sink = new AuditSink();
  const event = sink.record({
    kind: "guard.pass",
    targetId,
    decision: "injected",
  });
  assert.equal(
    event.decision,
    "injected",
    "a UUID targetId must not trigger audit suppression",
  );
  assert.equal(sink.lines_so_far().length, 1);
  assert.ok(sink.lines_so_far()[0]!.includes(targetId));
  assert.equal(looksSecretBearing(targetId), false);
});

test("looksSecretBearing still flags high-entropy opaque runs (B2 regression)", () => {
  const token = SECRET_SAMPLES.secrets.find(
    (s) => s.type === "high-entropy-token" || s.value.length >= 32,
  )!.value;
  assert.equal(looksSecretBearing(`prefix ${token} suffix`), true);
});

test("guard step 5 defaults to the real redactor when deps.redact is omitted (B1 regression)", async () => {
  const secret = SECRET_SAMPLES.secrets[1]!.value;
  const server = createFakeServer();
  server.state.store.set(
    "project/demo-proj/memory/2026/09/z.md",
    `---\nscope: project/demo-proj\n---\nKey was ${secret} in the fixture.`,
  );
  const adapter = new KiwiFSAdapter({
    url: ENDPOINT,
    ledger: createMemoryLedger(),
    fetchImpl: server.fetch,
  });
  await adapter.connect();
  // No `redact` in deps — the real T06 redactor must be the default.
  const guarded = await guardCandidate(
    "project/demo-proj/memory/2026/09/z.md",
    {
      adapter,
      authorizedScopes: ["project/demo-proj"],
    },
  );
  assert.ok(guarded.ok);
  assertSecretFree(guarded.body, "default-redactor guarded body");
  assert.ok(guarded.body.includes("[REDACTED:"));
});
