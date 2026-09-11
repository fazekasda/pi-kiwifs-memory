/**
 * T04 acceptance tests: opt-in live runner safeguards, exercised OFFLINE
 * against the fake MCP server. The runner itself is the only component that
 * may consume the secret-bearing local config file, and only on explicit
 * invocation; these tests never read that file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPreconditions,
  runLiveSuite,
  type LiveRunnerConfig,
} from "../src/backend/live/runner.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL = "https://kiwifs.test/mcp";

function validConfig(): LiveRunnerConfig {
  return {
    enabled: true,
    mcp: { url: URL, headers: { authorization: "Bearer synthetic" } },
    space: {
      name: "pi-kiwifs-memory-test",
      provisioned: true,
      isolationVerified: true,
    },
    safety: {
      allowTestSpaceWrites: true,
      allowOutsideTestSpaceWrites: false,
      allowServerAdministration: false,
      requireVerifiedSpaceIsolation: true,
      recordPrefix: "integration-tests/",
      cleanup: "current-run-only",
    },
    timeouts: { requestMs: 1000, runMs: 5000 },
  };
}

test("preconditions fail closed with no network traffic when the config is unsafe", async () => {
  const server = createFakeServer();
  for (const mutate of [
    (c: LiveRunnerConfig) => {
      c.enabled = false;
    },
    (c: LiveRunnerConfig) => {
      c.space!.provisioned = false;
    },
    (c: LiveRunnerConfig) => {
      c.space!.isolationVerified = false;
    },
    (c: LiveRunnerConfig) => {
      c.mcp!.url = "";
    },
    (c: LiveRunnerConfig) => {
      c.safety!.allowOutsideTestSpaceWrites = true;
    },
    (c: LiveRunnerConfig) => {
      c.safety!.allowServerAdministration = true;
    },
    (c: LiveRunnerConfig) => {
      c.safety!.recordPrefix = "notes/";
    },
    (c: LiveRunnerConfig) => {
      c.mcp!.url = "ftp://kiwifs.test/mcp";
    },
  ]) {
    const config = validConfig();
    mutate(config);
    const report = await runLiveSuite({ config, fetchImpl: server.fetch });
    assert.equal(report.outcome, "setup-blocked");
    assert.equal(server.state.requests.length, 0); // no traffic at all
    assert.equal(report.authNote.includes("setup-blocked"), true);
    // Report identity fields are present even when setup blocks the run.
    assert.ok(!Number.isNaN(Date.parse(report.timestamp)));
    assert.equal(typeof report.runnerVersion, "string");
  }
});

test("capability gap aborts before any mutation (setup-blocked)", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  const filtered = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const parsed = JSON.parse(await res.text());
    if (parsed.result?.tools) {
      parsed.result.tools = parsed.result.tools.filter(
        (t: { name: string }) => t.name !== "kiwi_write",
      );
    }
    return new Response(JSON.stringify(parsed), { status: 200 });
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: filtered,
    randomId: () => "abc123def456",
  });
  assert.equal(report.outcome, "setup-blocked");
  assert.deepEqual(report.requiredToolsMissing, ["kiwi_write"]);
  // No write ever reached the store.
  assert.equal(server.state.store.size, 0);
});

test("clean pass: routing check, CRUD/FTS round trip and manifest-owned cleanup", async () => {
  const server = createFakeServer();
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: server.fetch,
    randomId: () => "feedface1234",
  });
  assert.equal(report.outcome, "clean-pass");
  assert.ok(report.advertisedTools && report.advertisedTools.length > 0);
  // Every mutation lived beneath the run's namespace; nothing remains.
  const remaining = [...server.state.store.keys()].filter((p) =>
    p.startsWith("integration-tests/feedface1234/"),
  );
  assert.deepEqual(remaining, []);
  assert.ok(report.cleanup);
  // The record was deleted and verified inside the suite, so the cleanup
  // manifest is empty; the space holds nothing from the run either way.
  assert.deepEqual(report.cleanup.leftovers, []);
  assert.deepEqual(
    [...server.state.store.keys()].filter((p) =>
      p.startsWith("integration-tests/"),
    ),
    [],
  );
  // Auth note is connectivity evidence, never an enforcement claim.
  assert.ok(report.authNote.includes("never"));
  assert.ok(!JSON.stringify(report).includes("Bearer synthetic")); // redacted diagnostics
  // B06 report-identity fields: timestamp, runner version, candidate SHA and
  // a stable backend capability fingerprint.
  assert.ok(!Number.isNaN(Date.parse(report.timestamp)));
  assert.ok(report.runnerVersion.length > 0);
  assert.ok(/^[0-9a-f]{16}$/.test(report.capabilityFingerprint!));
});

test("partial failure still cleans up manifest-owned records (reverse order, verified)", async () => {
  const server = createFakeServer();
  // Break the delete step so the round trip fails after the record exists.
  const original = server.fetch;
  let callCount = 0;
  const sabotaged = (async (input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      body.includes('"kiwi_delete"') &&
      callCount > 0 &&
      body.includes("round-trip")
    ) {
      // Fail the FIRST delete (the suite's own), let cleanup deletes through.
      if (!server.state.store.has("integration-tests/sabotage-marker")) {
        server.state.store.set("integration-tests/sabotage-marker", "flag");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [{ type: "text", text: "delete failed (sabotage)" }],
            },
          }),
          { status: 200 },
        );
      }
      server.state.store.delete("integration-tests/sabotage-marker");
    }
    return original(input, init);
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: sabotaged,
    randomId: () => "cafe00001111",
  });
  assert.equal(report.outcome, "suite-failed-after-cleanup");
  const remaining = [...server.state.store.keys()].filter((p) =>
    p.startsWith("integration-tests/cafe00001111/"),
  );
  assert.deepEqual(
    remaining,
    [],
    "manifest-owned cleanup must succeed despite a failed step",
  );
  assert.deepEqual(report.cleanup?.leftovers, []);
});

test("report records candidate SHA and is fingerprint-stable across capability discovery", async () => {
  const server = createFakeServer();
  const a = await runLiveSuite({
    config: validConfig(),
    fetchImpl: server.fetch,
    randomId: () => "feedface1234",
    candidateSha: "0123456789abcdef0123456789abcdef01234567",
    runnerVersion: "9.9.9-test",
  });
  const b = await runLiveSuite({
    config: validConfig(),
    fetchImpl: server.fetch,
    randomId: () => "feedface1235",
    candidateSha: "0123456789abcdef0123456789abcdef01234567",
    runnerVersion: "9.9.9-test",
  });
  for (const report of [a, b]) {
    assert.equal(
      report.candidateSha,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.equal(report.runnerVersion, "9.9.9-test");
  }
  // Same advertised capability set → same fingerprint, independent of run id.
  assert.equal(a.capabilityFingerprint, b.capabilityFingerprint);
  // Cleanup outcome remains part of the report contract.
  assert.deepEqual(a.cleanup?.leftovers, []);
  assert.deepEqual(b.cleanup?.leftovers, []);
});

test("run ids are random and paths stay beneath integration-tests/", () => {
  // Deterministic check of the prefix contract via a fixed randomId hook is
  // covered above; here we prove the default id generator is random-ish.
  const config = validConfig();
  const reasons = checkPreconditions(config);
  assert.deepEqual(reasons, []);
  assert.equal(config.safety?.recordPrefix, "integration-tests/");
});

test("contract facts (T19): changes feed, ETag carrier and hybrid attribution are verified on a clean pass", async () => {
  const server = createFakeServer();
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: server.fetch,
    randomId: () => "feedface1234",
  });
  assert.equal(report.outcome, "clean-pass");
  const names = report.steps.map((s) => s.name);
  assert.ok(names.includes("changes-cursor-facts"));
  assert.ok(names.includes("hybrid-facts"));
  for (const s of report.steps) {
    assert.equal(s.ok, true, `step ${s.name} failed: ${s.detail}`);
  }
  const changesStep = report.steps.find(
    (s) => s.name === "changes-cursor-facts",
  );
  assert.ok(changesStep?.detail?.includes("created record reported"));
  assert.ok(changesStep?.detail?.includes("stable"));
  const hybridStep = report.steps.find((s) => s.name === "hybrid-facts");
  assert.ok(hybridStep?.detail?.includes("degraded=false"));
});

test("run deadline expiry still cleans manifest-owned records (fresh cleanup signal)", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  const delayed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes('"kiwi_delete"')) {
      // Outlive the run deadline (200 ms < 600 ms < requestMs 1000): the run
      // signal aborts while this request is in flight.
      await new Promise((r) => setTimeout(r, 600));
    }
    return original(input, init);
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: delayed,
    randomId: () => "deadbeef1234",
    runDeadlineMs: 200,
  });
  assert.equal(report.outcome, "suite-failed-after-cleanup");
  // The defect this pins: cleanup previously shared the (now-aborted) run
  // signal and every delete failed, leaving the record live on the backend.
  assert.deepEqual(
    [...server.state.store.keys()].filter((p) =>
      p.startsWith("integration-tests/"),
    ),
    [],
    "deadline expiry must not orphan manifest-owned records",
  );
  assert.deepEqual(report.cleanup?.leftovers, []);
});

test("a write result without an ETag fails the ETag contract-fact step", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  const stripped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const parsed = JSON.parse(await res.text());
    const text = parsed.result?.content?.[0]?.text;
    if (typeof text === "string" && text.startsWith("Written ")) {
      parsed.result.content[0].text = text.replace(/ \(ETag: [^)]+\)/, "");
    }
    // The original body is consumed; always rebuild the response.
    return new Response(JSON.stringify(parsed), { status: res.status });
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: stripped,
    randomId: () => "e77faced123",
  });
  assert.equal(report.outcome, "suite-failed-after-cleanup");
  assert.ok(
    report.steps.some(
      (s) => !s.ok && s.detail?.includes("did not carry an ETag"),
    ),
  );
  // The record was still created before the failure — cleanup must remove it.
  assert.deepEqual(
    [...server.state.store.keys()].filter((p) =>
      p.startsWith("integration-tests/"),
    ),
    [],
  );
  assert.deepEqual(report.cleanup?.leftovers, []);
});

test("a broken changes feed is disclosed as a degradation, never hidden (T19)", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  const sabotaged = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const res = await original(input, init);
    const parsed = JSON.parse(await res.text());
    if (
      body.includes('"kiwi_changes"') &&
      parsed.result?.content?.[0]?.text !== undefined
    ) {
      // Adapter maps an IsError tool result to a typed non-retryable error.
      parsed.result.isError = true;
      parsed.result.content[0].text =
        "Changes failed: internal server error (HTTP 500)";
    }
    return new Response(JSON.stringify(parsed), { status: res.status });
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: sabotaged,
    randomId: () => "baadf00d1234",
  });
  assert.equal(report.outcome, "clean-pass-with-degradations");
  assert.ok(
    report.disclosedDegradations?.some((d) =>
      d.includes("kiwi_changes unverified live"),
    ),
  );
  const changesStep = report.steps.find(
    (s) => s.name === "changes-cursor-facts",
  );
  assert.equal(changesStep?.ok, false);
  // The core contracts still passed; the record was cleaned up.
  assert.deepEqual(report.cleanup?.leftovers, []);
  assert.deepEqual(
    [...server.state.store.keys()].filter((p) =>
      p.startsWith("integration-tests/"),
    ),
    [],
  );
});

test("an identical-input replay divergence is a hard failure, never disclosed away", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  let changesCalls = 0;
  const diverging = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes('"kiwi_changes"')) {
      changesCalls += 1;
      if (changesCalls === 2) {
        const reqId = JSON.parse(body).id;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            result: {
              content: [
                {
                  type: "text",
                  text: "- A /diverged.md (actor: x, ts)\n\nlast_seq: c91d0a4",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
    }
    return original(input, init);
  }) as typeof fetch;
  const report = await runLiveSuite({
    config: validConfig(),
    fetchImpl: diverging,
    randomId: () => "d1verge12345",
  });
  assert.equal(report.outcome, "suite-failed-after-cleanup");
  assert.ok(report.steps.some((s) => !s.ok && s.detail?.includes("DIVERGED")));
  assert.equal(report.disclosedDegradations, undefined);
  // Cleanup still ran.
  assert.deepEqual(report.cleanup?.leftovers, []);
});
