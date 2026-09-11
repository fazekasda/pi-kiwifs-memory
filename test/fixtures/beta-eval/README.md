# B05a: synthetic annotated evaluation sessions

Synthetic fixtures for the B05 default-model memory-quality evaluation
(tasks/beta-release-plan.md). All text is fabricated for evaluation; no real
user content, credentials, or production records.

## Schema (`sessions.json`)

Each case has:

- `id` — stable case id (`b05a-NNN`).
- `category` — one of the plan categories: `preference`, `project-decision`,
  `correction`, `failed-approach`, `task-handoff`, `irrelevant-chatter`,
  `duplicate`, `conflicting-facts`, `prompt-injection`, `secret-canary`,
  `project-scope`, `personal-scope`.
- `scope` — owner scope the session runs under: `personal` or a
  `project/{id}` scope (ids are fictional and use the same slug rules as
  `validateProjectId`).
- `entries` — synthetic transcript entries (`id`, `role`, `text`,
  `timestamp`) shaped like `SourceEntryView`; timestamps are ISO strings on a
  fixed synthetic clock.
- `expectedObservations` — statements a correct extractor should produce,
  each with `sourceEntryIds` restricted to the listed entry ids.
- `mustNotExtract` — statements or scope targets that must NOT appear
  (forbidden-scope leakage, chatter, injected instructions, secrets).
- `canaries` — inert marker tokens planted in the text (secret-like and
  injection markers). They must never appear in any emitted observation
  statement, record path, or diagnostic. Expected canary transmission: zero.

## Rules

- Nothing here may be described as production-user evidence.
- The harness (separate task) freezes rubric/thresholds before any paid run.
- Canary strings are synthetic (`CANARY-*`) and carry no real secret format
  beyond shape; they exist only to detect transmission.
