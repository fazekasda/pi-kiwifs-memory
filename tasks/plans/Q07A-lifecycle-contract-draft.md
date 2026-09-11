# Q07A — Config lifecycle: narrow mapping + documented lifecycle contract (contract; ratified at commit — see §7)

Task label: Q07A_lifecycle_contract. Scope is deliberately NARROW: inventory the
existing config read sites, classify live vs snapshot settings, propose the
smallest owner with fail-closed/transient behavior, and document the lifecycle
contract (live vs next-session; endpoint/scope queue hazards). No code changes,
no test changes in Q07A itself; the tests named below are the evidence contract
for the follow-on implementation task (Q07B) to accept.

Inputs honored:

- Q02 settled-boundary tradeoff evidence: `tasks/evidence/q02c-evidence.md`
  (pull-read per boundary vs push `notifyTransition`; cancel fires once per
  observed normal→private transition, AFTER state is private; lazy resume via
  next pull) and `tasks/evidence/q02d-evidence.md` (boundary classification of
  private-period entries; pre-private pending batches untouched under original
  opIds; `extractNow` refusal does not classify) and
  `tasks/evidence/q02-closure-evidence.md` (per-delivery AbortSignal; aborted
  jobs HELD, never retried/quarantined/dropped).
- Q06 composition (f0cea46): `buildSessionRuntime` in `src/runtime/session.ts`
  is the single construction owner; index is composition/lifecycle only;
  commands/runtime never import index.

## 1. Inventory — every config read site (`loadConfig` / derived reads)

Legend: LIVE = value re-read per check/boundary (reread-dependent);
SNAPSHOT = read once at construction, consumed for the session runtime's
lifetime; DISPLAY = per-render status/command view.

| #   | Site                                                                            | Kind          | Consumers / live gate that depends on the reread                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/privacy/live-gate.ts` `liveConfigPrivateMode()` (L36)                      | LIVE          | THE shared fail-closed private-mode read: outbox worker tick hold, `assertNetworkAllowed` pre-send recheck, `LiveConfigPrivateModeGate.observe()` (cancel push on normal→private), model gate `assertModelCallAllowed` (extractor/reflector per-attempt), scheduler `isPrivate` boundary                                                                                   |
| 2   | `src/runtime/session.ts:459` retrieval `privateMode: () => { loadConfig(); … }` | LIVE          | retrieval per-cycle gate (invalid config ⇒ private, zero reads)                                                                                                                                                                                                                                                                                                            |
| 3   | `src/runtime/session.ts:504` backup `privateMode: () => …`                      | LIVE          | backup per-capture gate (no new backup jobs; invalid ⇒ hold)                                                                                                                                                                                                                                                                                                               |
| 4   | `src/runtime/session.ts:547` board `liveGate()`/`repoGate`                      | LIVE          | board delivery per-cycle + repository reads (invalid ⇒ zero reads/writes)                                                                                                                                                                                                                                                                                                  |
| 5   | `src/runtime/session.ts:195` `buildSessionRuntime` head                         | SNAPSHOT      | **the session snapshot**: `enabled`, `effectiveFeatures` (observation/backup/board), `mcp.url`, `mcp.auth` (→ `openBearerAdapter`/`buildBearerAdapter` construction), `board.consumerId`, `scopes` (record scope resolution, retrieval authorized scopes), `privacy.exclusions`, `budgets.*` (ragDeadlineMs, evidenceTokenCap, tokenizer spec), `model.route`/`model.auth` |
| 6   | `src/index.ts:231` `recallDeps()` (per tool call)                               | LIVE(partial) | `config.privateMode`, `budgets.ragDeadlineMs` re-read per recall tool call; runtime object itself from the SNAPSHOT-built runtime                                                                                                                                                                                                                                          |
| 7   | `src/index.ts:258` `boardDeps()` (per tool call)                                | LIVE(partial) | `config.privateMode`, `effectiveFeatures(config).board` per board tool call; adapter from the SNAPSHOT-built runtime                                                                                                                                                                                                                                                       |
| 8   | `src/index.ts:470` `configGate()` (per command)                                 | LIVE(partial) | `valid` + `enabled` + `privateMode` gate for mutating commands; `config` object passed through is a fresh read                                                                                                                                                                                                                                                             |
| 9   | `src/index.ts:489` `controlSurface` `configFile: loadConfig().file`             | LIVE          | resolved config file path for private-mode persistence                                                                                                                                                                                                                                                                                                                     |
| 10  | `src/runtime/status.ts:197` `resolveStatusText()`                               | DISPLAY       | per status render; fail-visible (never throws)                                                                                                                                                                                                                                                                                                                             |
| 11  | `src/commands/backup-commands.ts:30`                                            | DISPLAY/gate  | per-command fresh read for backup-verify gating                                                                                                                                                                                                                                                                                                                            |
| 12  | `src/commands/control-commands.ts:79`                                           | DISPLAY       | per-command status/queue/erasure-report view                                                                                                                                                                                                                                                                                                                               |
| 13  | `src/commands/board-commands.ts:151`                                            | DISPLAY/gate  | per-command board gc/cleanup view + gate                                                                                                                                                                                                                                                                                                                                   |
| 14  | `src/commands/registration.ts` via injected `configGate` (sites 8)              | gate          | shared instance from index — no second gate owner                                                                                                                                                                                                                                                                                                                          |

Non-`loadConfig` config consumers: `src/retrieval/tokenizer.ts`
`loadConfiguredTokenizer(spec, baseDir)` — takes the SNAPSHOT's tokenizer spec
(never re-reads config); `src/privacy/audit-store.ts` — path fixed at
construction, no config surface parsed (Q04: unwired, unapproved proposal).

Observations from the inventory:

- There is exactly ONE structural pattern already: LIVE private-mode/enabled
  reads (sites 1–4 are the same predicate re-implemented 4×:
  `!r.ok || r.config.privateMode`), and ONE snapshot at site 5. Sites 6–8
  re-implement the predicate or partial views per callsite.
- **Snapshot ownership today:** `buildSessionRuntime` (site 5) owns the only
  durable snapshot; every adapter, budget, scope, exclusion and feature flag
  is frozen at runtime construction. Nothing in the running runtime re-reads
  structural config. This is de-facto "next-session settings".
- **Invalidation signals today:** NONE for structural config. The only
  invalidation signal is the private-mode push
  (`setPrivateModeInFile` ok → `notifyPrivateTransition()` → shared gate
  observes at transition time). Everything else is pull-per-boundary. There
  is no mtime watcher, no file hash, no epoch counter.

## 2. Live vs next-session settings (documented contract)

LIVE (reread-dependent, take effect at the next boundary without rebuild):

- `privateMode` — every domain gate (outbox, retrieval, backup, board, model,
  scheduler, recall/board tools, command gate). Invalid/unreadable config
  fails CLOSED to private. In-flight work: best-effort cancel (model + outbox
  signal path, Q02c/closure); already-sent bytes are not recallable.
- `enabled` — command config gate refuses mutating commands immediately.
  (Feature enablement for the RUNNING runtime is snapshot: see below.)

NEXT-SESSION (snapshot at `buildSessionRuntime`; mid-session edits are visible
in status but do NOT reconfigure the live runtime):

- `mcp.url`, `mcp.auth` (adapters hold the construction-time endpoint/secret
  ref), `board.consumerId`, scopes (project/personal/cross-project opt-in),
  `privacy.exclusions`, `budgets.*`, tokenizer spec, `model.route`/`model.auth`,
  `effectiveFeatures` (observation/backup/board enablement), `enabled` for the
  running scheduler/delivery loop.

Documented rationale (matches existing shipped behavior; Q07A changes
nothing): a safe session-boundary rebuild is preferable to invented live
reconfiguration. Adapters, delivery cursors, outbox ledger and scope
resolution are entangled with the snapshot; hot-swapping any of them would be
new, unapproved behavior. Status (sites 10–13) already renders the CURRENT
file, so the user sees that a change is staged for next session.

## 3. Queue hazards (endpoint/credential/scope vs persisted jobs)

Hard rule from the task: endpoint/credential/scope changes cannot reroute
persisted jobs; no silent reinterpretation of queued scope; no loss or
duplicate delivery.

Current behavior to be pinned by the contract (and tested in Q07B):

- Mid-session endpoint/auth/consumerId edit: the runtime keeps its
  construction-time adapter, so pending jobs keep flowing to the ORIGINAL
  endpoint. No reroute is possible mid-session (snapshot). ✔
- **Session-boundary rebuild with a changed endpoint** is the hazard: a new
  runtime resolves the NEW endpoint/credential and the outbox worker would
  deliver OLD jobs to the NEW endpoint. Under the no-reroute rule this must
  be refused: jobs must carry an enqueue-time target fingerprint
  (endpoint URL + auth-ref identity + record scope), checked before send;
  mismatch ⇒ HELD with a visible sanitized reason (never delivered to the
  new target, never dropped, never quarantined). Resume of delivery to the
  original target requires the config to match again (or an explicitly
  approved future operator action — out of scope here).
- Scope changes: a persisted job's record scope was resolved at enqueue
  (explicit override or git-remote discovery). A next-session scope change
  must not reinterpret the queued job's scope: same fingerprint rule applies
  to the scope component; mismatch ⇒ hold visibly.
- Credential value rotation with the SAME `mcp.auth` ref and SAME url is NOT
  a reroute (target identity unchanged) — delivery proceeds. Only ref
  identity/url/scope changes trigger the hold. This keeps the common
  "rotate the secret file" case working without any new machinery.
- Duplicate/loss invariants unchanged: ack-after-resolve; aborted/held jobs
  stay pending under the original opId (Q02 closure evidence).

## 4. Proposed smallest owner (Q07B implementation proposal)

Smallest owner = extend the EXISTING shared gate, not a new subsystem:
promote `src/privacy/live-gate.ts` into the single LIVE-config owner
(`src/config/live.ts` or keep the file — Q07B decides; one-way dep
config → privacy is preserved either way) and collapse sites 1–4 (and the
predicate halves of 6–8) onto it.

Minimal API (additive; existing exports unchanged):

```ts
// Live-view read — the ONE fail-closed predicate, implemented once:
export interface ConfigLiveView {
  readonly ok: boolean; // config file read + validated
  readonly privateMode: boolean; // true when !ok (fail closed)
  readonly enabled: boolean; // false when !ok
  /** first sanitized issue/fatal, for status only — never secrets/paths of others */
  readonly invalidReason?: string;
}
export function readConfigLive(): ConfigLiveView; // single loadConfig wrapper

// The existing gate keeps its API (isPrivate/notifyTransition/onCancel/
// assertModelCallAllowed/holdWhilePrivate/assertNetworkAllowed/…) but its
// `read` becomes readConfigLive; site 2–4 closures become
// () => gate.isPrivate (or view reads) with zero predicate duplication.
```

Transient/invalid config, atomic replacement behavior (contract, to test):

- Any read failure or validation failure ⇒ `privateMode: true, enabled:
false` — every LIVE gate fails closed for that boundary only. No caching
  of the failure beyond the boundary (next read re-evaluates).
- Our own writes are already atomic (temp + fsync + rename, 0o600,
  pre-rename validation — `setPrivateModeInFile`), so a transient invalid
  window from our own control path cannot exist; external editors may still
  create one, and the contract for that is per-boundary fail-closed, never
  a crash and never a stale-permit.
- No retry loop, no debounce, no watcher in Q07B: the pull-per-boundary read
  IS the invalidation signal, exactly as Q02 settled. The push
  (`notifyTransition`) stays the transition-time accelerator only for
  private-mode flips, unchanged.
- No snapshot invalidation/rebuild signal is introduced in Q07B. Rebuild
  remains the existing session lifecycle (`session_shutdown` disposes
  everything; next `session_start`/event rebuilds). Structural changes take
  effect next session, by contract, and status shows the current file.
- Outbox job-target fingerprint (§3): the only NEW persisted-shape element
  proposed. Must be additive (new optional field on new jobs; existing
  persisted jobs without a fingerprint are treated as SAME-TARGET legacy —
  they deliver as today; no migration, no reinterpretation).

What Q07B must NOT do: no live reconfiguration of adapters/scopes/features;
no config watcher thread; no caching layer that could serve a stale permit;
no widening of `onRelease` auto-fire (Q02c documented why it must not fire
inside a tick read — duplicate-delivery risk); no change to private-period
entry classification (Q02d).

## 5. Microtask plan (for the Q07B implementation worker)

1. **Q07B1 — single predicate collapse.** Introduce `readConfigLive`;
   rewire `liveConfigPrivateMode` and the site 2/3/4 closures to it. Zero
   behavior change; all existing suites green. Evidence: new
   `test/q07b1-live-view.test.ts` (predicate equivalence incl. fatal vs
   issues vs unreadable; fail-closed on throw) + full `npm run check`.
2. **Q07B2 — job-target fingerprint.** Additive enqueue-time fingerprint on
   new outbox jobs; pre-send target check in the worker/sender; mismatch ⇒
   hold with sanitized reason surfaced via the existing hold-reason probes.
   Evidence: `test/q07b2-target-pin.test.ts` through the SHIPPED
   `buildSessionRuntime` (endpoint change across rebuild ⇒ held, zero
   requests; same-ref credential rotation ⇒ delivers; scope change ⇒ held;
   legacy fingerprint-less job ⇒ unchanged behavior; no duplicate ack).
3. **Q07B3 — docs + status truthfulness.** Document live vs next-session
   fields (docs/configuration.md + architecture.md), add a status line
   distinguishing "active (session snapshot)" vs "staged for next session"
   where a cheap sanitized diff is available — only if the diff is
   metadata-only (field names/values that are already status-safe).
   Evidence: doc lines + `q06c1`-style status test extension.

Each microtask: synthetic-only tests (temp config files, mode-0600,
throwaway env, fetch intercepted), bounded native node --test runs, no real
endpoints, explicit stage scan, no commit until the final Q07 gate.

## 6. Evidence contract (Q07 acceptance artifacts)

- `tasks/evidence/q07b1-live-view.md`, `q07b2-target-pin.md`,
  `q07b3-docs.md` — exact commands, pass/fail counts, typecheck, secret scan
  of the explicit staged list.
- Required demonstrations:
  a. Invalid config (unparseable + validation-issues + missing) ⇒ every live
  gate reports private, zero network attempts, visible sanitized status.
  b. Transient invalid window: file invalid at read N, valid at N+1 ⇒ N
  fails closed, N+1 proceeds — no cached permit, no crash.
  c. Endpoint/scope change across session rebuild ⇒ pending jobs HELD
  visibly, never delivered to the new target, never dropped; resume with
  restored config delivers exactly once under the original opId.
  d. Credential value rotation (same ref/url) ⇒ delivery proceeds.
  e. Private-mode flip push path unchanged (q02c suite still green).
- Full gates at Q07 close: `npm run check`, `npm run pack:check`,
  `devenv test`; unrelated `t19-budget-report.json` jitter left unstaged.

## 7. Safety questions — RATIFIED for Q07 (coordinator acceptance, 2026 review round)

The four defaults below were flagged as open during Q07A and were accepted
verbatim at commit time after independent review. No behavior beyond them is
approved; any change reopens this section.

1. **Rebuild-time reroute policy:** RATIFIED as hold-on-mismatch. No
   automatic release on a changed endpoint; an explicit user-confirmed
   release command, if ever wanted, is future work requiring approval.
2. **Legacy jobs without a fingerprint:** RATIFIED as deliver-as-today
   (documented in docs/configuration.md). No extra warning required; the
   docs section carries the caveat.
3. **`enabled: false` mid-session:** RATIFIED as snapshot. The running
   scheduler/delivery loop keeps running until session end; `enabled` gates
   command admission immediately. A live kill switch would be new behavior.
4. **Status "staged for next session" diff (Q07B3):** RATIFIED as
   metadata-only. "config valid — changes apply next session" is enough; no
   field-name-level structural diff is exposed.
