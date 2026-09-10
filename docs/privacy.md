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

  **Q04a (proposal, not yet approved config):** durable storage is provided
  by `FileAuditStore` (`src/privacy/audit-store.ts`): JSONL with bounded
  rotation (256 KiB × 3 files default), private permissions (dir 0700,
  files 0600), best-effort single-owner lock file, trailing-corruption
  repair, and content-free degraded status on disk-full/fs faults (events
  buffered in a bounded 64-line memory fallback, never falsely
  acknowledged). Lock takeover is pid-first: a live owner's lock is never
  stolen regardless of age; only a dead owner's lock, or an unreadable lock
  older than `staleLockMs`, is taken over once. Rotated segments numbered
  beyond `maxRotatedFiles` from a prior larger configuration are removed at
  init so the on-disk budget holds after reconfiguration.

  **Q04b (runtime wiring):** `buildSessionRuntime` instantiates the durable
  store as the production outbox audit sink (`<stateDir>/audit.log`, Q04a
  default limits, no config surface parsed yet). The outbox worker records
  sent / retry / quarantined / private-hold transitions (metadata-only). A
  degraded sink surfaces as a sanitized, content-free status note
  (`audit: DEGRADED — buffered=<n> writeFailures=<n> lastError=<errno class>`,
  counts and errno classes only) and degrades the overall state line;
  session shutdown releases the lock so a next session is never a second
  writer for the same log. Proposal change events persist only the proposal
  FILENAME (basename) in `targetId` — never a user-typed path (no home
  directory / username components). A `privacy.audit.file` configuration
  surface with these explicit defaults remains a proposal for future
  approval.

  **Q04c (domain event coverage):** the same production sink now records
  metadata-only events from every domain, via the existing typed
  `AuditSinkLike` seam (no duplicate audit implementations):
  - observation (`kind: "observation"`): `captured` (short content-free
    record id + entry count), `held (private mode)` (private-session
    classification / manual hold), `failed (<error name>)`.
  - reflection (`kind: "reflection"`): `ran` (16-char prefix of the
    content-free set hash), `skipped (<reason>)`, `held (redaction)`,
    `failed (<error name>)`.
  - backup (`kind: "backup"`): `captured` / `captured (with held entries)`
    (chunk/held/omission counts), `held (private mode)`,
    `held (invalid exclusions)`, `skipped (no candidates)`.
  - retrieval (`kind: "retrieval"`): `completed` / `completed (degraded)`
    (item/token counts), `held (private mode)`, `held (no authorized
scopes)`, `skipped (ineligible: ...)`, `skipped (privacy
classification)`, `degraded (deadline exceeded)`, `failed (<name>)`.
  - board (`kind: "board"`): per-cycle `completed` (delivered/skipped/
    changes/pages counters) or `held (private|backlog|unavailable|stopped|
consumer lock)`, `completed (listing fallback)` / `(listing truncated)`.
  - change (`kind: "change"`): proposal `approved` / `rejected` / `undone`
    / `failed (<error name>)` with the proposal path as target id.
  - commands (`kind: "command"`): `/kiwifs-forget` and
    `/kiwifs-forget-undo` `ok (...)` / `failed (...)` with the op id only —
    never the record path or forget reason.

  All domain events are metadata-only: identifiers, reason codes and
  counters; no query text, message bodies, paths with user content, model
  responses or error text. Every line passes the same schema allowlist,
  secret-free post-check and 2048-byte bound (a line that trips the
  post-check is downgraded to `audit-suppressed` — e.g. long opaque
  record paths, so short record ids are used instead). Disabled behavior:
  a domain constructed without a sink records nothing and never fails.
  Audit logging failure never authorizes a request, drops pending work, or
  falsely acknowledges it: the domain action completes independently and
  the sink's degraded status surfaces via the Q04b status note.

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
