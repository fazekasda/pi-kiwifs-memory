/** Type declarations for scripts/model-eval.mjs (B05 evaluation harness). */

export interface EvalMemory {
  content: string;
  scope: "project" | "personal";
  conflict?: boolean;
}

export interface TransportResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs?: number;
}

export interface EvalTransport {
  kind: string;
  complete(args: { prompt: string; caseId: string }): Promise<TransportResult>;
}

export interface CaseMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  duplicateEmissions: number;
  conflictExpected: number;
  conflictClassified: number;
  forbiddenScopeLeakage: number;
  canaryTransmissions: number;
}

export interface EvalSummary {
  configVersion: string;
  thresholds: Readonly<Record<string, number>>;
  corpusHash: string;
  model: string;
  transport: string;
  sampleCount: number;
  precision: number;
  recall: number;
  duplicateRate: number;
  conflictClassifiedRate: number;
  forbiddenScopeLeakage: number;
  secretCanaryTransmissions: number;
  malformedRecoveryRate: number;
  meanCallsPerSession: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  costEstimateUsd: number;
  generatedAt: string;
  passed: boolean;
}

export const MODEL_SLUG: string;
export const OPENROUTER_MODEL_ID: string;
export const EVAL_CONFIG_VERSION: string;
export const THRESHOLDS: Readonly<Record<string, number>>;
export const CORPUS: {
  id: string;
  category: string;
  scope: string;
  turns: { role: string; text: string }[];
  expect: { key: string; scope: string }[];
  expectConflictKeys?: string[];
  mustNotExtract: string[];
  injection: string | null;
  canaries: string[];
}[];

export const FIXTURE_PATH: string;
export function normalizeStatement(s: string): string;

export function corpusHash(): string;
export function runIdFor(transportKind: string): string;
export function buildExtractionPrompt(
  turns: { role: string; text: string }[],
): string;
export function fakeTransport(
  complete: (r: TransportResult) => TransportResult,
  opts?: { canaryEcho?: boolean },
): EvalTransport;
export function openRouterTransport(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): EvalTransport;
export function parseModelJson(text: string): EvalMemory[] | null;
export function sanitizeExtraction(
  rawText: string,
  parsed: EvalMemory[] | null,
): { ok: boolean; rawDigest?: string; memories?: unknown[] };
export function defaultKeyMatcher(mem: unknown): string | null;
export function scoreCase(
  caseSpec: {
    expect: { key: string; scope: string }[];
    expectConflictKeys?: string[];
    canaries?: string[];
  },
  records: unknown[],
  opts?: { keyMatcher?: (mem: unknown) => string | null },
): CaseMetrics;
export function runEvaluation(opts: {
  transport: EvalTransport;
  resultsDir: string;
  keyMatcher?: (mem: unknown) => string | null;
  maxRetries?: number;
  log?: (msg: string) => void;
}): Promise<{ summary: EvalSummary; perCase: { caseId: string }[] }>;
