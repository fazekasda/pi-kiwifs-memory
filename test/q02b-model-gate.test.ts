/**
 * Q02b acceptance tests: private-mode gate at the model HTTP request
 * boundary (extractor + reflector), deterministic fake transports only —
 * no real model calls, no network. Scheduler/runtime hookup is deferred to
 * Q06 (wiring test remains the Q01 Gap 2 acceptance witness).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtractionModelError,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelRequestGate,
  createModelExtractor,
  wireModelId,
} from "../src/observation/model.ts";
import {
  ReflectionModelError,
  createModelReflector,
  type ReflectFn,
} from "../src/observation/reflection.ts";
import type { ExtractionBatch } from "../src/observation/scheduler.ts";
import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  DEFAULT_OUTPUT_BUDGET_TOKENS,
} from "../src/observation/scheduler.ts";
import { PrivateModeActiveError } from "../src/privacy/private-mode.ts";

const ROUTE = "openrouter/z-ai/glm-5.3-flash";
process.env["Q02B_KEY"] = "test-key-not-real";
const KEY = { kind: "env", ref: "Q02B_KEY" } as const;

function batch(): ExtractionBatch {
  return {
    opId: "00000000-0000-4000-8000-000000000001",
    trigger: "threshold",
    inputBudgetTokens: DEFAULT_INPUT_BUDGET_TOKENS,
    outputBudgetTokens: DEFAULT_OUTPUT_BUDGET_TOKENS,
    sources: [
      { id: "e1", role: "user", text: "We use Postgres." },
      { id: "e2", role: "assistant", text: "Noted." },
    ],
  };
}

/** Deterministic gate. onCancel listeners are exposed for mid-flight cancel. */
function fakeGate(privateMode: boolean): ModelRequestGate & {
  setPrivate(value: boolean): void;
  emitCancel(reason: string): void;
} {
  let isPrivate = privateMode;
  const cancelListeners: ((reason: string) => void)[] = [];
  return {
    get private() {
      return isPrivate;
    },
    setPrivate(value: boolean) {
      isPrivate = value;
    },
    assertModelCallAllowed() {
      if (isPrivate) throw new PrivateModeActiveError("observation");
    },
    onCancel(listener: (reason: string) => void) {
      cancelListeners.push(listener);
    },
    emitCancel(reason: string) {
      for (const l of cancelListeners) l(reason);
    },
  } as never;
}

const VALID_BODY = JSON.stringify({
  observations: [
    {
      sourceEntryIds: ["e1"],
      statement: "The team uses Postgres as the storage engine.",
      uncertainty: "low",
    },
  ],
});

function modelResponse(text: string): ModelChatResponse {
  return {
    ok: true,
    text,
    reportedModel: wireModelId(ROUTE),
    usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.00001 },
  };
}

// 1. Private mode → extractor refuses NEW call before any bytes sent.
test("extractor refuses the model call while private mode is ON (zero fetches)", async () => {
  const calls: ModelChatRequest[] = [];
  const gate = fakeGate(true);
  const extract = createModelExtractor({
    route: ROUTE,
    auth: KEY,
    gate,
    transport: async (req) => {
      calls.push(req);
      return modelResponse(VALID_BODY);
    },
  });
  await assert.rejects(
    extract(batch()),
    (err: Error) =>
      err instanceof ExtractionModelError && err.reason === "private-mode",
  );
  assert.equal(calls.length, 0, "no model bytes may be sent while private");
});

// 2. Gate re-checked before the corrective retry: exactly 1 fetch, no leak.
test("extractor re-checks the gate before the validation retry", async () => {
  const calls: ModelChatRequest[] = [];
  const gate = fakeGate(false);
  const extract = createModelExtractor({
    route: ROUTE,
    auth: KEY,
    gate,
    transport: async (req) => {
      calls.push(req);
      if (calls.length === 1) {
        gate.setPrivate(true);
        return modelResponse("not json at all");
      }
      return modelResponse(VALID_BODY);
    },
  });
  await assert.rejects(
    extract(batch()),
    (err: Error) =>
      err instanceof ExtractionModelError && err.reason === "private-mode",
  );
  assert.equal(
    calls.length,
    1,
    "retry must not leak a second fetch once private",
  );
});

// 3. Normal mode: happy path unchanged.
test("extractor behaves unchanged when the gate reports normal mode", async () => {
  const calls: ModelChatRequest[] = [];
  const gate = fakeGate(false);
  const extract = createModelExtractor({
    route: ROUTE,
    auth: KEY,
    gate,
    transport: async (req) => {
      calls.push(req);
      return modelResponse(VALID_BODY);
    },
  });
  const result = await extract(batch());
  assert.equal(result.observations.length, 1);
  assert.equal(calls.length, 1);
});

// 4. Reflector same: private gate → typed refusal, zero fetches.
test("reflector refuses the model call while private mode is ON (zero fetches)", async () => {
  const calls: ModelChatRequest[] = [];
  const gate = fakeGate(true);
  const reflect: ReflectFn = createModelReflector({
    route: ROUTE,
    auth: KEY,
    gate,
    transport: async (req) => {
      calls.push(req);
      return {
        ok: true,
        text: '{"summary":"s","duplicates":[["a","b"]],"conflicts":[]}',
        reportedModel: wireModelId(ROUTE),
      };
    },
  });
  await assert.rejects(
    reflect({
      setHash: "h",
      records: [{ recordId: "a", statements: ["x"], uncertainty: "low" }],
      inputBudgetTokens: 1_000,
      outputBudgetTokens: 1_000,
    }),
    (err: Error) =>
      err instanceof ReflectionModelError && err.reason === "private-mode",
  );
  assert.equal(calls.length, 0);
});

// 5. Cancel in-flight: gate cancel aborts the live attempt's controller.
test("gate cancel aborts the in-flight extractor attempt (bounded)", async () => {
  const gate = fakeGate(false);
  let observedSignal: AbortSignal | undefined;
  let settle: (r: ModelChatResponse) => void = () => {};
  const extract = createModelExtractor({
    route: ROUTE,
    auth: KEY,
    gate,
    transport: (req) =>
      new Promise<ModelChatResponse>((resolve, reject) => {
        observedSignal = req.signal;
        req.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
        settle = () => resolve(modelResponse(VALID_BODY));
      }),
  });
  const pending = extract(batch());
  // Bounded wait until the transport captured the signal.
  for (let i = 0; i < 100 && observedSignal === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(observedSignal, "transport must receive an abort signal");
  assert.equal(observedSignal?.aborted, false);
  gate.emitCancel("private-mode transition");
  assert.equal(
    observedSignal?.aborted,
    true,
    "in-flight attempt aborted best-effort",
  );
  await assert.rejects(
    pending,
    (err: Error) =>
      err instanceof ExtractionModelError && err.reason === "private-mode",
  );
  // Drain the transport promise (it rejected via the aborted signal).
  await pending.catch(() => {});
});
