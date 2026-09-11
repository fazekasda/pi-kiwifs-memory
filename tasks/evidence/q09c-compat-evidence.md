# Q09C — compatibility and integration evidence (Node 22.19.0 exact / Node 24, RPC + PTY TUI)

Task label: Q09C_compatibility_rpc_tui. HEAD before work: 2363b52 (Q08).
No commits made; staging deferred to the final Q09 commit gate.

Scope: compatibility/integration evidence only — the complete test suite on
EXACT Node 22.19.0 and Node 24, the audited isolated RPC fixture extended
with queued-followUp / repeated-input / private-flip / headless
personal-write / confirm-refusal coverage, and an automated PTY TUI smoke.
No behavior or policy changes; test-harness additions only. All synthetic and
local: fake MCP backend and scripted openai-completions SSE model on
127.0.0.1 only, unreachable loopback port for the TUI smoke. ZERO model
calls, ZERO live backends, ZERO remote requests. NOTHING here is a
production model evaluation.

## 1. Toolchain: exact Node versions

- Node 24: `v24.19.0` (`node --version`), the machine default
  (`/etc/profiles/per-user/fazekasda/bin/node`, nixpkgs nodejs_24).
- Node 22.19.0 EXACT: official binary tarball
  `https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz`,
  sha256-verified against the published SHASUMS256.txt
  (`c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2`,
  match), extracted to `~/.local/share/node-versions/` (outside the repo;
  toolchain download only, never a model call). No other 22.x was
  substituted; nothing else was installed for this run.

## 2. Credential isolation verified BEFORE the runs

Static audit of the audited RPC harness (`test/pi-rpc-fixture.test.ts`):
the spawned Pi process receives ONLY `PATH` plus fixture-owned variables —
`HOME`/`PI_CODING_AGENT_DIR`/`KIWIFS_MEMORY_CONFIG`/`KIWIFS_MEMORY_STATE_DIR`
(all under a per-run temp dir) and `T13_FIXTURE_TOKEN` (a fixture dummy).
`models.json` in the fixture agent dir points the provider at a loopback
server the test spawns itself.

Runtime verification (pre-run, bounded, read-only):
`/tmp/q09c-isolation-check.sh` launches the fixture and dumps the
environment VARIABLE NAMES of the live spawned Pi child from
`/proc/<pid>/environ` (values never read):

```
== environment variable names visible to the spawned Pi process ==
HOME
KIWIFS_MEMORY_CONFIG
KIWIFS_MEMORY_STATE_DIR
PATH
PI_CODING_AGENT_DIR
T13_FIXTURE_TOKEN
OK: no credential-bearing environment variables reach the spawned Pi process
OK: all listening sockets are loopback-only.
fixture: tests 1, pass 1, fail 0
```

The operator shell's real credential variables (e.g. `FIRECRAWL_API_KEY`,
provider env) do NOT propagate to the harness child. Endpoint audit: every
listening socket held by the harness stack is 127.0.0.1.

## 3. Full suite on both exact versions

One sequential sidecar run (`/tmp/q09c-suites.log`):

```
=== NODE24 ===
v24.19.0
npm run check        # typecheck + format:check + node --test test/*.test.ts
ℹ tests 675  ℹ pass 675  ℹ fail 0  (duration_ms 63313)
NODE24_RC=0
=== NODE22.19.0 ===
v22.19.0
node node_modules/typescript/bin/tsc --noEmit   # TSC22_OK
node --test test/*.test.ts
# tests 675  # pass 675  # fail 0  (duration_ms 63576)
NODE22_RC=0
```

675/675 on both exact versions, zero failures, no skips/cancellations. The
suite includes the Q09A outbox-coalescing, Q09B runtime-budget and the
extended RPC fixture tests.

## 4. RPC fixture coverage (real Pi 0.85.0 process, loopback-only)

`test/pi-rpc-fixture.test.ts` — same audited isolated process, same scripted
model (bounded at 8 provider calls). Passes 3/3 consecutive runs. The Q09C
additions assert, against the REAL Pi RPC process:

1. **Repeated user input**: the same fresh prompt submitted a second time
   gets a full fresh cycle — its own retrieval + `before_agent_start` → a
   SECOND persistent pack on the provider call (exactly 2 persistent packs;
   repeated input is never silently deduped away).
2. **Queued followUp**: `prompt` with `streamingBehavior: "followUp"`
   submitted while the repeated-input run streams. Pi queues the expanded
   text and replays it as the consuming run's next turn — verified: the
   followUp text reaches the provider context, the pack injects via the
   transient context path EXACTLY ONCE (call carries 2 persistent + exactly
   1 transient pack), and NO new `before_agent_start` fires for it. The
   degraded `unmatched evidence pack(s) dropped at run settle` note does NOT
   appear (the pack matched and was consumed).
3. **Private-mode flip through the real control surface**:
   `/kiwifs-private-mode` → `private mode: OFF`; `on` → `private mode ON —
all domains hold (zero reads/writes at the next gate); in-flight
retrieval invalidated (generation bumped)`; `status` → ON; `off` →
   `private mode OFF — gated features resume at their next cycle`. The flip
   persists to the fixture config and round-trips through the single
   live-config owner.
4. **Private-mode command refusal (headless, real RPC)**: while private mode
   is ON, `/kiwifs-personal-note … --yes` is refused outright by the shared
   command gate (`private mode active — all domains hold (zero
reads/writes); use /kiwifs-private-mode off to resume`): the outbox
   counters are byte-identical before/after and the note text never reaches
   the backend.
5. **Headless personal write (`--yes`)** after the flip: the note saves into
   the durable outbox (`personal note saved`), pending rises by exactly 1,
   and the next worker tick delivers it idempotently to the fake backend
   (`kiwi_write` on the wire). Redact-before-durable-write proven end to
   end: the delivered body carries `[REDACTED:aws-access-key:20]` and the
   raw synthetic secret appears NOWHERE (provider bodies, outbox path,
   backend requests). Outbox ends with nothing quarantined; both personal
   jobs acked (acked counter ≥ 2, pending only shrinks).
6. **Confirm/refusal dialogs over real RPC**: `/kiwifs-personal-note`
   without a scripted answer raises a REAL `extension_ui_request` confirm
   dialog; the fixture answers via `extension_ui_response`. The dialog
   message for the secret-bearing note shows the REDACTED preview (raw
   secret never rendered). Confirming saves (queue +1, delivered, acked);
   answering false yields `personal note cancelled` and enqueues nothing
   (queue counters unchanged, backend never sees the refused note text).

   In RPC the command context HAS a UI, so `--yes` does NOT bypass the
   dialog — the dialog still guards the write (Pi 0.85.0 behavior pinned by
   this fixture).

Harness gaps fixed (test code only, no src changes):

- the fixture never answered `extension_ui_request` confirm dialogs (an RPC
  confirm would have blocked forever); it now answers with a scripted
  answer, refusing unexpected dialogs by default (fail-safe);
- fixture config: added `schemaVersion: 1` (the private-mode flip's
  edit-validation correctly refuses to rewrite a config that lacks it —
  fail-closed behavior confirmed on the way) and
  `scopes.allowPersonalGlobal: true` (the personal-write scenario requires
  it; the fixture asserted `personal-global scope: denied` before);
- `/kiwifs-queue` stats are parsed and compared relatively (the baseline
  may legitimately contain earlier runs' backup-chunk jobs, and the first
  tick may deliver them too); test timeout raised 120 s → 180 s for the
  bounded delivery-tick wait.

## 5. Automated PTY TUI smoke (NOT human signoff)

Real PTY via herdr sidecar pane; pi 0.85.0 TUI, node v24.19.0. Isolated
launch:

```
env -i PATH=<shell PATH> HOME=<temp> PI_CODING_AGENT_DIR=<temp>/agent \
  KIWIFS_MEMORY_CONFIG=<temp>/kiwifs.config.json \
  KIWIFS_MEMORY_STATE_DIR=<temp>/state \
  Q09C_DUMMY_TOKEN=dummy-synthetic-token PI_OFFLINE=1 TERM=xterm-256color \
  node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-session --no-extensions --no-skills --no-prompt-templates --no-themes \
  -e src/index.ts
```

`PI_OFFLINE=1` disables startup network operations (the first launch showed
an update banner, so it was restarted with PI_OFFLINE and none appeared).
Config: synthetic, `mcp.url = http://127.0.0.1:9/` (unreachable loopback
port), auth = env ref of a dummy token, empty providers registry. State dir
deleted after the smoke. Zero model calls (no prompt was ever submitted —
commands only); the TUI itself showed the fail-closed `No models available`
/ `No API key found` warnings (zero credentials configured).

Captured verbatim (ANSI snapshots):

- `/kiwifs-private-mode status` → `private mode: OFF`
- `/kiwifs-private-mode on` → status → `private mode: ON — all domains hold
(zero reads/writes)`
- `/kiwifs-private-mode off` → `private mode OFF — gated features resume at
their next cycle`
- `/kiwifs-personal-note Q09C-PTY-REFUSED …` → dialog rendered:
  ```
  Save personal note
  Statement: Q09C-PTY-REFUSED synthetic note must never save
  Scope: personal-global (your own memory space). Saved to the durable
  outbox and delivered idempotently. Nothing is promoted from project
  memory and no model call is made.
  → Yes
    No
  ↑↓ navigate  enter select  escape/ctrl+c cancel
  ```
  down + enter (No) → `personal note cancelled` (refusal; nothing saved)
- `/kiwifs-personal-note Q09C-PTY-CONFIRMED …` → dialog → enter on Yes →
  `personal note saved (scope: personal; queued for idempotent delivery)`;
  `/kiwifs-queue` → `outbox: pending=1 quarantined=0 acked=0 bytes=653`
  (durable outbox; the unreachable backend is a retryable hold, never a
  quarantine, never a crash).
- A second confirmed note reproduced the saved notify verbatim.

Process isolation at capture time: the TUI process (`/proc/<pid>/environ`,
names only) sees exactly `HOME, KIWIFS_MEMORY_CONFIG, KIWIFS_MEMORY_STATE_DIR,
PATH, PI_CODING_AGENT_DIR, Q09C_DUMMY_TOKEN, TERM` — no credential-bearing
variable beyond the fixture dummy; the process held ZERO open socket fds.
TUI exited `TUI_EXIT_RC=0` (SIGTERM → clean shutdown); temp tree removed.

## 6. Reproduction

```
# isolation pre-check (bounded, local)
/tmp/q09c-isolation-check.sh

# full gates, Node 24 (default)
npm run check

# exact Node 22.19.0
export PATH=$HOME/.local/share/node-versions/node-v22.19.0-linux-x64/bin:$PATH
node --version          # v22.19.0
node node_modules/typescript/bin/tsc --noEmit
node --test test/*.test.ts

# RPC fixture alone
node --test test/pi-rpc-fixture.test.ts
```

## 7. Limits

- The PTY TUI interaction is an automated smoke (send-keys + ANSI snapshots
  with bounded wait guards), not human signoff.
- The scripted model and fake backend are synthetic; the injected packs,
  notes and redactions are fixtures. This file proves COMPATIBILITY and
  integration behavior (versions, RPC/TUI paths, gating, redaction-on-wire,
  durable outbox), NOT production model or tokenizer quality.
- `tasks/evidence/t19-budget-report.json` benchmark jitter (a side effect of
  any full `npm run check` run, which regenerates it) was deliberately
  handled: the regenerated values (958–965 ms across Node 22.19.0 and
  Node 24.19.0 runs in this session) are wall-clock jitter around the same
  budget, NOT the Q09 latency evidence. The committed values (959–965 ms,
  Node 24.19.0) remain the recorded actual-run evidence from the T19
  benchmark session; the post-run regeneration was reverted in the working
  tree before staging. The Q09 latency evidence is
  `test/q09b-runtime-budgets.test.ts` (deterministic injected delays),
  which is unaffected.
