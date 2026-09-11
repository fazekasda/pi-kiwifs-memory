export interface EvalTokenizer {
  id: string;
  countTokens(text: string): number | undefined;
}

export interface EvalCorpus {
  entries: { id: string; category: string; text: string }[];
  evidenceSets: { id: string; items: unknown[] }[];
  hash: string;
}

export interface EvalReport {
  tokenizerId: string;
  corpusHash: string;
  entryCount: number;
  evidenceSetCount: number;
  deterministic: boolean;
  malformed: string[];
  aggregate: {
    totalRawTokens: number;
    minEntryTokens?: number;
    maxEntryTokens?: number;
    undefinedCounts: number;
    framingOffsets: { set: string; offset?: number }[];
    framingOffsetsStable: boolean;
  };
}

export declare function loadCorpus(): EvalCorpus;
export declare function loadCandidate(spec?: {
  module: string | undefined;
  export?: string | undefined;
}): Promise<
  { ok: true; tokenizer: EvalTokenizer } | { ok: false; reason: string }
>;
export declare function evaluate(
  tokenizer: EvalTokenizer,
  corpus: EvalCorpus,
): EvalReport;
