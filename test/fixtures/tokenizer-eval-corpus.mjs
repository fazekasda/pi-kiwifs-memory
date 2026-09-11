/**
 * B04a synthetic tokenizer-evaluation corpus.
 *
 * SYNTHETIC, NOT PRODUCTION: every string below is invented for this
 * fixture. No user text, credentials, endpoints, tokens, or record paths.
 * Deterministic: same module load produces byte-identical content, so the
 * corpus hash is stable across runs and machines.
 *
 * Categories required by B04: multilingual prose, source code, JSON,
 * Unicode edge cases, long evidence frames, and evidence item sets that
 * pass through the exact `frameEvidence` framing from
 * `src/inject/packer.ts` (including the reflection-body rendering branch).
 */

/** Multilingual prose (English, German, Japanese, Hungarian, Arabic). */
const MULTILINGUAL = [
  `The retrieval coordinator counts the complete injected payload before any message reaches the model. Evidence bodies, framing lines and source citations all share one enforced cap.`,
  `Der Beleg wird als nicht vertrauenswürdige Daten markiert. Konfliktbeschriftungen dienen nur der Information und werden niemals automatisch angewendet.`,
  `記憶の証拠は信頼できないデータとして枠付けされます。埋め込まれた指示はデータとして扱われ、実行されません。ソースIDは角括弧内に表示されます。`,
  `A memória-kereső minden találatot forrásazonosítóval és hatókör-címkével jelenít meg. A bizonytalán konfliktusok címkéje tájékoztató jellegű.`,
  `تُعرض الأدلة المسترجعة كبيانات غير موثوقة فقط، ولا تُعتبر التعليمات المدمجة فيها أوامر صالحة. تُذكر معرّفات المصادر بين قوسين معقوفين.`,
];

/** Source code in three languages, including strings and comments. */
const SOURCE_CODE = [
  `function countTokens(text) {
  if (typeof text !== "string") return undefined;
  // every non-letter run becomes its own token
  return text.match(/[\\p{L}\\p{N}]+/gu)?.length ?? 0;
}`,
  `def frame(items):
    lines = ["Memory evidence (UNTRUSTED DATA)"]
    for i, item in enumerate(items):
        lines.append(f"[Memory:E{i + 1} source={item.path}]")
    return "\\n\\n".join(lines)`,
  `interface Config {
  budgets: { evidenceTokens: number };
  tokenizer?: { module: string; export?: string };
}`,
];

/** JSON documents, compact and pretty, with nested arrays and escapes. */
const JSON_DOCS = [
  `{"scope":"project/alpha","summary":"decision recorded","conflicts":[{"recordIds":["r-1","r-2"],"label":"superseded by later decision"}]}`,
  `{
  "id": "E12",
  "path": "notes/2026/synthetic-entry.md",
  "score": 0.87,
  "tags": ["build", "release", "checklist"],
  "nested": {"a": [1, 2, 3], "b": {"c": null}}
}`,
];

/** Unicode edge cases: emoji, ZWJ, combining marks, RTL, CJK punctuation. */
const UNICODE = [
  `café naïve Übersicht — “curly quotes” … ellipsis, em—dash, ‑ hyphen`,
  `family 👨‍👩‍👧‍👦 flag 🇭🇺 math ∑∫≈ x² → y, CJK、punctuation。full-width！`,
  `زوجة مكتبة　ideal　mixed　ideographic　spaces　and combining é̲ marks`,
];

/** One very long body to exercise per-item length behavior. */
const LONG_BODY = Array.from(
  { length: 60 },
  (_, i) =>
    `Synthetic paragraph ${i + 1}: the packer renders each evidence item with a source header line and the redacted body; repeated filler establishes a long, uniform frame for token accounting. Lorem-like but original text follows to reach realistic length.`,
).join("\n\n");

/** Well-formed reflection bodies exercising the packer's parsed branch. */
const REFLECTION_BODIES = [
  [
    "Reflection summary:",
    "The team chose option B after the option A build failed twice.",
    "Conflicting claims (unresolved — informational labels, never auto-applied):",
    "- older note said option A was chosen [conflicting records: r-7, r-9]",
  ].join("\n"),
  "Reflection summary: release checklist updated; no conflicts recorded.",
];

export const CORPUS_ENTRIES = [
  ...MULTILINGUAL.map((text, i) => ({
    id: `multilingual-${i + 1}`,
    category: "multilingual-prose",
    text,
  })),
  ...SOURCE_CODE.map((text, i) => ({
    id: `source-code-${i + 1}`,
    category: "source-code",
    text,
  })),
  ...JSON_DOCS.map((text, i) => ({
    id: `json-${i + 1}`,
    category: "json",
    text,
  })),
  ...UNICODE.map((text, i) => ({
    id: `unicode-${i + 1}`,
    category: "unicode",
    text,
  })),
  { id: "long-body-1", category: "long-body", text: LONG_BODY },
  ...REFLECTION_BODIES.map((text, i) => ({
    id: `reflection-${i + 1}`,
    category: "reflection-body",
    text,
  })),
];

/**
 * Evidence item sets for the exact packer framing. Bodies are synthetic;
 * paths are plausible-but-fake and carry no user content.
 */
export const EVIDENCE_SETS = [
  {
    id: "mixed-3",
    items: [
      {
        path: "notes/synthetic/decision.md",
        scope: "project/alpha",
        body: SOURCE_CODE[0],
        score: 0.9,
        leg: "fts",
      },
      {
        path: "memory/reflections/r-1.md",
        scope: "project/alpha",
        body: REFLECTION_BODIES[0],
        score: 0.8,
        leg: "semantic",
      },
      {
        path: "notes/synthetic/unicode.md",
        scope: "personal",
        body: UNICODE[0],
        score: 0.7,
        leg: "hybrid",
        attribution: "keyword only",
      },
    ],
  },
  {
    id: "long-single",
    items: [
      {
        path: "notes/synthetic/long.md",
        scope: "project/beta",
        body: LONG_BODY,
        score: 0.6,
        leg: "brief",
      },
    ],
  },
  {
    id: "empty",
    items: [],
  },
];

/** Categories that must be present for the corpus to be valid. */
export const REQUIRED_CATEGORIES = [
  "multilingual-prose",
  "source-code",
  "json",
  "unicode",
  "long-body",
  "reflection-body",
];
