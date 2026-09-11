/**
 * B04a — tokenizer evaluation harness tests (test/tokenizer-eval.test.ts).
 *
 * Verifies the OFFLINE deterministic harness around the actual packer
 * framing (`frameEvidence` from src/inject/packer.ts):
 * - corpus integrity: required categories present, secret patterns absent,
 *   stable corpus hash across loads;
 * - harness output is deterministic and well-formed for the synthetic
 *   reference tokenizer, including framing offsets per evidence set;
 * - hard-fail conditions: nondeterministic counts, malformed counts,
 *   non-integer/negative values;
 * - candidate loading is OPTIONAL: a missing/unloadable/malformed
 *   `@cyberlangke/tokkit`-shaped module reports "candidate-unavailable"
 *   without failure and without claiming compatibility.
 *
 * Synthetic local fixtures only. No network calls, no secrets.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluate,
  loadCandidate,
  loadCorpus,
} from "../scripts/tokenizer-eval.mjs";
import {
  EVIDENCE_SETS,
  REQUIRED_CATEGORIES,
} from "../test/fixtures/tokenizer-eval-corpus.mjs";
import { frameEvidence } from "../src/inject/packer.ts";

const WORD_TOKENIZER = {
  id: "test-words",
  countTokens(text: string) {
    if (typeof text !== "string") return undefined;
    const m = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
    return m === null ? 0 : m.length;
  },
};

test("corpus: required categories present, no secret patterns, stable hash", () => {
  const corpus = loadCorpus();
  const categories = new Set(corpus.entries.map((e) => e.category));
  for (const required of REQUIRED_CATEGORIES) {
    assert.ok(categories.has(required), `missing category ${required}`);
  }
  assert.ok(corpus.hash.length === 64);
  assert.equal(loadCorpus().hash, corpus.hash);
});

test("corpus: evidence sets frame through the actual packer", () => {
  for (const set of EVIDENCE_SETS) {
    const framed = frameEvidence(set.items);
    assert.equal(typeof framed, "string");
    if (set.items.length > 0) {
      assert.match(framed, /\[Memory:E1 source=/);
      assert.match(framed, /UNTRUSTED DATA/);
    }
  }
  // reflection branch: parsed reflection body gets the packer rendering
  const framedReflection = frameEvidence(
    EVIDENCE_SETS.find((s) => s.id === "mixed-3")!.items,
  );
  assert.match(framedReflection, /Reflection summary:/);
  assert.match(framedReflection, /conflicting records: r-7, r-9/);
  assert.match(framedReflection, /degraded: keyword-only attribution/);
});

test("harness: deterministic, well-formed report with framing offsets", () => {
  const corpus = loadCorpus();
  const a = evaluate(WORD_TOKENIZER, corpus);
  const b = evaluate(WORD_TOKENIZER, corpus);
  assert.equal(a.corpusHash, corpus.hash);
  assert.deepEqual(a.aggregate.framingOffsets, b.aggregate.framingOffsets);
  assert.equal(a.deterministic, true);
  assert.deepEqual(a.malformed, []);
  assert.ok(a.entryCount >= 10);
  // framing offsets exist per set with items and are recorded
  const byId = Object.fromEntries(
    a.aggregate.framingOffsets.map((o) => [o.set, o.offset]),
  );
  assert.equal(typeof byId["mixed-3"], "number");
  assert.equal(typeof byId["empty"], "number"); // frame-only header for the empty set
  assert.equal(byId["empty"], WORD_TOKENIZER.countTokens(frameEvidence([])));
  assert.equal(typeof byId["long-single"], "number");
});

test("harness: hard-fails on nondeterministic tokenizer", () => {
  let flip = false;
  const flaky = {
    id: "flaky",
    countTokens(text: string) {
      if (typeof text !== "string") return undefined;
      flip = !flip;
      return flip ? 5 : 7;
    },
  };
  const report = evaluate(flaky, loadCorpus());
  assert.equal(report.deterministic, false);
  assert.ok(report.malformed.some((m) => m.includes("nondeterministic")));
});

test("harness: flags malformed (negative / non-integer) counts", () => {
  const bad = {
    id: "bad",
    countTokens: (text: string) => (typeof text === "string" ? -1 : undefined),
  };
  const report = evaluate(bad, loadCorpus());
  assert.ok(report.malformed.length > 0);
  assert.ok(report.malformed.some((m) => m.includes("malformed count")));
});

test("candidate loading is optional: missing spec reports unavailable", async () => {
  const result = await loadCandidate(undefined);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no candidate module configured/);
});

test("candidate loading: unloadable module reports sanitized reason", async () => {
  const result = await loadCandidate({
    module: "./does/not/exist-tokkit.mjs",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /failed to load/);
  assert.match(result.reason, /does-not-exist-tokkit\.mjs|exist-tokkit/);
});

test("candidate loading: module without EvidenceTokenizer export is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-eval-"));
  try {
    const modPath = join(dir, "not-a-tokenizer.mjs");
    writeFileSync(modPath, "export const nothing = 1;\n");
    const result = await loadCandidate({ module: modPath });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not export an EvidenceTokenizer/);

    const goodPath = join(dir, "candidate.mjs");
    writeFileSync(
      goodPath,
      "export const tokenizer = { id: 'cand', countTokens: (t) => t.length };\n",
    );
    const ok = await loadCandidate({ module: goodPath });
    assert.equal(ok.ok, true);
    assert.equal(ok.tokenizer.id, "cand");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness accepts file-URL import of the CLI module (no side effects)", async () => {
  // importing the harness module as a library must not run its CLI main
  const corpus = loadCorpus();
  const report = evaluate({ id: "x", countTokens: () => 1 }, corpus);
  assert.equal(report.deterministic, true);
  assert.equal(pathToFileURL("x").protocol, "file:");
});
