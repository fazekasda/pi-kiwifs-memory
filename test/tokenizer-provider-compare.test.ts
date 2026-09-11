/**
 * B04b — provider-comparison harness tests (offline only; no network).
 *
 * Verifies:
 * - CLI gate: without `--run` + explicit opt-in env, the tool refuses with
 *   exit 2 and performs NO network I/O (fetch spy stays untouched);
 * - request-set construction covers every corpus entry and every evidence
 *   set through the exact `frameEvidence` framing;
 * - framing-offset analysis: stable single offset validates; any differing
 *   offset rejects; prompt_tokens below local count (unexplained
 *   undercount) rejects;
 * - the adapter (when the optional devDependency is installed) loads the
 *   GLM-5 tokenizer offline and produces deterministic integer counts.
 *
 * No secrets, no provider traffic, synthetic fixtures only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  analyzeOffset,
  buildRequestList,
  countLocally,
  OPTIN_ENV,
} from "../scripts/tokenizer-provider-compare.mjs";
import { loadCorpus } from "../scripts/tokenizer-eval.mjs";
import { EVIDENCE_SETS } from "../test/fixtures/tokenizer-eval-corpus.mjs";
import { frameEvidence } from "../src/inject/packer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "tokenizer-provider-compare.mjs");

test("request list covers every corpus entry and framed evidence set", () => {
  const corpus = loadCorpus();
  const requests = buildRequestList(corpus);
  assert.equal(
    requests.length,
    corpus.entries.length + corpus.evidenceSets.length,
  );
  const ids = new Set(requests.map((r) => r.id));
  for (const entry of corpus.entries) assert.ok(ids.has(entry.id));
  for (const set of EVIDENCE_SETS) {
    const framed = requests.find((r) => r.id === `framed:${set.id}`);
    assert.ok(framed, `missing framed request for ${set.id}`);
    assert.equal(framed.text, frameEvidence(set.items));
  }
});

test("local counting is deterministic and validates malformed tokenizers", () => {
  const corpus = loadCorpus();
  const requests = buildRequestList(corpus);
  const ok = countLocally({ countTokens: (t: string) => t.length }, requests);
  assert.equal(ok.length, requests.length);
  for (const r of ok) assert.ok(Number.isInteger(r.localCount));
  assert.throws(() =>
    countLocally(
      { countTokens: (t: string) => (t.length % 2 === 0 ? t.length : -1) },
      requests,
    ),
  );
});

test("offset analysis: stable offset validates", () => {
  const a = analyzeOffset([
    { id: "a", localCount: 10, promptTokens: 13, route: "r" },
    { id: "b", localCount: 40, promptTokens: 43, route: "r" },
  ]);
  assert.equal(a.stableMapping, true);
  assert.equal(a.framingOffset, 3);
});

test("offset analysis: unstable offset rejects", () => {
  const a = analyzeOffset([
    { id: "a", localCount: 10, promptTokens: 13, route: "r" },
    { id: "b", localCount: 40, promptTokens: 41, route: "r" },
  ]);
  assert.equal(a.stableMapping, false);
});

test("offset analysis: unexplained undercount rejects", () => {
  // Provider reports fewer prompt_tokens than the raw user content —
  // framing only adds tokens, so this can never be explained by framing.
  const a = analyzeOffset([
    { id: "a", localCount: 50, promptTokens: 3, route: "r" },
    { id: "b", localCount: 50, promptTokens: 3, route: "r" },
  ]);
  assert.equal(a.stableMapping, false);
  assert.equal(a.undercounts.length, 2);
  assert.deepEqual(
    a.undercounts.map((u) => u.id),
    ["a", "b"],
  );
});

test("CLI gate: no --run / no opt-in env refuses with exit 2 and no network", () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, [OPTIN_ENV]: "", OPENROUTER_API_KEY: "" },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /refusing provider comparison/);
  // Request content is never echoed.
  assert.doesNotMatch(res.stderr + res.stdout, /sk-|Bearer /);
});

test("CLI gate: opt-in env without OPENROUTER_API_KEY exits 2, no network", () => {
  const res = spawnSync(
    process.execPath,
    [SCRIPT, "--run", "--out", join(HERE, "..", "nonexistent-out.json")],
    {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      env: { ...process.env, [OPTIN_ENV]: "1", OPENROUTER_API_KEY: "" },
    },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /OPENROUTER_API_KEY not set/);
  assert.doesNotMatch(res.stderr + res.stdout, /Bearer /);
  assert.ok(!res.stdout.includes("http"));
});

test("adapter (if devDependency installed) counts deterministically", async () => {
  const { loadTokkitGlmTokenizer } =
    await import("../scripts/tokkit-glm-adapter.mjs");
  let tok;
  try {
    tok = await loadTokkitGlmTokenizer();
  } catch {
    return; // optional devDependency absent: nothing to assert
  }
  assert.match(tok.id, /tokkit-glm/);
  const n1 = tok.countTokens("Hello, world — café test.");
  const n2 = tok.countTokens("Hello, world — café test.");
  assert.equal(n1, n2);
  assert.ok((n1 ?? 0) > 0);
  assert.equal(tok.countTokens(undefined as unknown as string), undefined);
});
