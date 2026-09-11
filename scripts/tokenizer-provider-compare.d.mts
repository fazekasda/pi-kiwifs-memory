export declare const MODEL_SLUG: string;
export declare const OPENROUTER_MODEL_ID: string;
export declare const OPTIN_ENV: string;

export interface ProviderCompareRequest {
  id: string;
  kind: "entry" | "framed-evidence-set";
  text: string;
}

export interface ProviderCompareSample {
  id: string;
  localCount: number;
  promptTokens: number;
  route: string;
}

export interface OffsetAnalysis {
  perRequest: {
    id: string;
    localCount: number;
    promptTokens: number;
    offset: number;
  }[];
  undercounts: { id: string; offset: number }[];
  framingOffset: number | undefined;
  stableMapping: boolean;
}

export interface ProviderCompareReport {
  task: string;
  verdict: "validated" | "rejected";
  rejectionReasons: string[];
  model: string;
  requestSettings: unknown;
  node: string;
  candidatePackage: string;
  corpusHash: string;
  requestCount: number;
  results: OffsetAnalysis["perRequest"];
  framingOffset: number | null;
  stableMapping: boolean;
  generatedAt: string;
}

export declare function buildRequestList(
  corpus: unknown,
): ProviderCompareRequest[];
export declare function countLocally(
  tokenizer: { countTokens(text: string): number | undefined },
  requests: ProviderCompareRequest[],
): { id: string; localCount: number }[];
export declare function analyzeOffset(
  samples: ProviderCompareSample[],
): OffsetAnalysis;
export declare function providerPromptTokens(opts: {
  text: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ promptTokens: number; route: string }>;
export declare function runProviderComparison(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<ProviderCompareReport>;
