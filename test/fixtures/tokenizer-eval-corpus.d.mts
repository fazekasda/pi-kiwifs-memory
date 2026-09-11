import type { EvidenceItem } from "../src/retrieval/coordinator.ts";

export interface CorpusEntry {
  id: string;
  category: string;
  text: string;
}

export interface CorpusEvidenceSet {
  id: string;
  items: EvidenceItem[];
}

export declare const CORPUS_ENTRIES: CorpusEntry[];
export declare const EVIDENCE_SETS: CorpusEvidenceSet[];
export declare const REQUIRED_CATEGORIES: string[];
