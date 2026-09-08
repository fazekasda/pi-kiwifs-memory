# Privacy gate — behavior, exclusions, private mode, audit (T06)

Implements decisions.md #10 and architecture.md §5/§10. All code under
`src/privacy/`; outbound edges (guard step 5, future write/query/queue paths)
wire the redactor exported from `src/privacy/redaction.ts`.

## What the gate enforces

- **Redact before every outbound edge**: model requests, backend writes,
  query transmission, durable queue storage and audit logging all consume
  redacted content. Detection is pattern-based (common secret formats: AWS
  access keys, `sk-` API keys, GitHub/Slack tokens, JWTs, bearer headers, PEM
  private-key blocks, credential-bearing URLs, `password =` assignments) plus
  an entropy heuristic over long opaque token runs (default ≥ 4.0 bits/char,
  ≥ 20 chars). Replacement is structural: `[REDACTED:{type}:{length}]` —
  never a hash or truncation of the secret itself.
- **Fail closed**: content the scanner cannot classify safely (control
  characters, non-string input, internal scanner faults) is **held** — the
  redactor returns `ok: false` and callers must refuse to send it. Guard
  step 5 (`src/backend/guard.ts`) turns a hold into a candidate rejection.
- **Exclusions** (`config.privacy.exclusions`, validated in T03's schema):
  a rule may specify `project` (scope value), `pathPrefix` (backend path
  prefix, whole-file) and/or `pattern` (content regex). Dimensions are ANDed
  within a rule; rules are ORed. Content matching an exclusion is never
  captured, so it never reaches any outbound edge. An invalid pattern fails
  closed at compile time (`compileExclusions`), never silently at capture.
- **Private mode** (`src/privacy/private-mode.ts`): no network reads or
  writes in any of the three feature domains (observation, backup, board),
  no new capture/backup/board jobs. Pending outbox jobs are **held, never
  deleted** (no drop-oldest); resuming is an explicit `resume()` call that
  releases held jobs and is recorded as a visible transition event. T07's
  outbox worker must consult `assertNetworkAllowed()` before every send and
  route accepted work through `holdWhilePrivate()`.
  **Hard T07 requirement:** a listener must be registered via
  `onResume()` (or resume handled inline) _before_ the gate is ever enabled.
  `resume()` releases held references only to registered listeners; with no
  listener attached the held payloads are not delivered anywhere (only the
  release count survives in the transition event). Held-never-dropped
  applies while jobs are held; delivering them is the listener's job.
- **Sanitized audit** (`src/privacy/audit.ts`): default records are
  metadata-only — `{ts, kind, feature, scope, targetId, byteCounts, decision,
degraded}`. Payload snippets exist only at user-enabled `snippets`
  verbosity, and only after redaction; an unclassifiable snippet is withheld.
  Every serialized line is post-checked; a line that still looks
  secret-bearing is downgraded to an `audit-suppressed` stub rather than
  persisted.

## Scanner limitations (read before trusting redaction)

- Pattern/entropy scanning is a **best-effort heuristic, not a guarantee**.
  A secret in an unrecognized format, below the entropy/length thresholds, or
  split across a redaction boundary can pass through. Novel secret formats
  will be missed until a pattern exists for them.
- The entropy heuristic produces **false positives** (random-looking
  identifiers, checksums) that get redacted unnecessarily, and **false
  negatives** (low-entropy secrets like short passwords outside `key = value`
  shapes). Neither direction is safe to "fix" by tuning alone.
- Exclusion `pattern` rules apply at capture time to content the extension
  sees; they cannot redact text already stored in the backend, in Git
  history, or in earlier transcripts.
- User-provided exclusion patterns can themselves cause over-redaction or
  under-redaction; they are user policy, not safety guarantees.

## Backup fidelity implications

- Redaction is **irreversible**: redacted transcript chunks cannot be
  restored to their original bytes. Per decisions.md #2, backups are redacted
  with an explicit omission manifest; **no byte-identical recovery is
  claimed or possible**. Completeness statements must always say "complete
  with recorded redactions/omissions" (architecture.md §7).
- Redaction counts (by type, never values) are recorded in backup manifests
  so users can see how much was removed — but the counts do not prove the
  scanner caught everything (limitations above).

## Node compatibility

Built on stable Node ≥ 22.19.0 APIs only (`RegExp`, `JSON`, `Map`,
`Date.prototype.toISOString`); no version-gated surface.
