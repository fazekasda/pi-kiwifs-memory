# pi-kiwifs-memory

A KiwiFS memory extension for [Pi](https://pi.dev). It connects a running
KiwiFS service to Pi sessions and provides three opt-in features:

- **Observational memory.** After agent responses settle, unprocessed turns
  are batched and sent to a configurable model (default
  `openrouter/z-ai/glm-5.3-flash`) for observation extraction. Writes go
  through a durable local outbox, so Pi keeps working during backend
  outages and nothing pending is dropped. Reflection summaries and
  duplicate/merge proposals are generated over accepted records; merge
  proposals apply only after explicit approval.
- **Retrieval.** Each eligible user input triggers one bounded retrieval
  cycle (2 s total deadline by default) across the authorized scopes. Up to
  3,000 tokens of read-back-verified, redacted evidence is injected as
  untrusted, source-labeled data. The agent also gets explicit tools:
  `kiwifs_memory_search` and `kiwifs_memory_read`.
- **Redacted session backups.** The transcript tree is captured in redacted
  chunks with a manifest (binaries omitted and recorded). Verify and export
  with `/kiwifs-backup-verify`.
- **Agent-to-agent message board.** Channels on the shared backend, with
  durable per-consumer delivery and local acknowledgment. Tools:
  `kiwifs_board_send`, `kiwifs_board_list`, `kiwifs_board_read`,
  `kiwifs_board_inbox`, `kiwifs_board_ack`.

User commands: `/kiwifs-status`, `/kiwifs-private-mode`,
`/kiwifs-extract-now`, `/kiwifs-reflect-now`, `/kiwifs-proposal`,
`/kiwifs-forget`, `/kiwifs-forget-undo`, `/kiwifs-personal-note`,
`/kiwifs-board-cleanup`,
`/kiwifs-backup-verify`,
`/kiwifs-board-gc`, `/kiwifs-queue`, `/kiwifs-erasure-report`. All are
headless/RPC safe; record-mutating ones require explicit confirmation.

Privacy: content is redacted before every outbound edge (model calls,
backend writes, queries, queue, audit log). Configurable exclusions never
capture matched content. Private mode holds ALL reads and writes in all
three domains, with pending work held and never deleted.

## Requirements

- Pi 0.85.0 (the version this was developed and tested against; the package
  peer dependency is intentionally open, not a tested-version claim).
- Node.js >= 22.19.0. The test suite runs on exact Node 22.19.0 and Node 24.
- An existing KiwiFS service with its MCP endpoint. The extension connects
  to your service; it does not install or manage a backend. Tested against
  KiwiFS v0.19.62.

## Setup

1. Install the extension:

   ```sh
   pi install git:github.com/fazekasda/pi-kiwifs-memory
   # or, from a local checkout:
   pi install /absolute/path/to/pi-kiwifs-memory
   ```

   There is no npm release yet; publication is a separate, approved step
   (see `docs/publishing.md`). Do not also use `-e` while the same
   extension is installed locally.

2. Write a config file and point `KIWIFS_MEMORY_CONFIG` at it. A minimal
   opt-in example with credentials by environment-variable reference:

   ```json
   {
     "schemaVersion": 1,
     "enabled": true,
     "mcp": {
       "url": "https://kiwifs.example.internal/mcp",
       "auth": { "kind": "env", "ref": "KIWIFS_MCP_APIKEY" }
     },
     "model": {
       "route": "openrouter/z-ai/glm-5.3-flash",
       "auth": { "kind": "env", "ref": "OPENROUTER_API_KEY" }
     },
     "budgets": {
       "tokenizer": { "module": "/abs/path/to/my-tokenizer.mjs" }
     },
     "board": { "consumerId": "laptop-1" }
   }
   ```

   ```sh
   export KIWIFS_MEMORY_CONFIG="$HOME/.config/kiwifs/memory.json"
   export KIWIFS_MCP_APIKEY="..."
   export OPENROUTER_API_KEY="..."
   ```

   Never put secret values in the config file; the schema rejects inline
   credentials. Point `mcp.url` at an apikey-authenticated MCP endpoint. A
   standalone unauthenticated MCP port must never be used across an
   untrusted network; see `docs/operations.md`.

3. Supply a tokenizer module for your model (`budgets.tokenizer`). Without
   one, automatic context injection stays skipped with a visible note and
   the explicit search/read tools keep working. The extension never
   approximates the token cap with character estimates and never silently
   falls back. See `docs/configuration.md` for the module contract.

4. Start Pi and run `/kiwifs-status`. It shows the overall state
   (`healthy`, `degraded`, `private`, `disabled`) and the resolved
   non-secret settings. If anything failed to initialize, the reason is on
   that screen, not buried in a log.

Full field reference: [docs/configuration.md](docs/configuration.md).
Running the features day to day, outage/queue behavior, backup rules,
forgetting and erasure limits, troubleshooting:
[docs/operations.md](docs/operations.md).

## State on disk

Per project: `<project>/.kiwifs/memory/` (override with
`KIWIFS_MEMORY_STATE_DIR`) holds the outbox queue, board delivery state,
session-coordinator state and op logs, with `0700` permissions. Add
`.kiwifs/` to your project's `.gitignore`; this queue holds redacted
payloads and must not be committed. The config file path comes from
`KIWIFS_MEMORY_CONFIG`.

## Development

Install [Nix](https://nixos.org/download/), [devenv](https://devenv.sh/getting-started/),
and [direnv](https://direnv.net/docs/installation.html).
Use devenv 1.8.2, matching CI. Enable the
[direnv shell hook](https://direnv.net/docs/hook.html) once in your shell configuration.
These tools are already installed on the original development machine.

```sh
git clone https://github.com/fazekasda/pi-kiwifs-memory.git
cd pi-kiwifs-memory
direnv allow
npm ci
npm run dev
```

Run `/kiwifs-status` in Pi. Restart `npm run dev` after editing the source.
`npm run dev` uses the Pi CLI installed in `node_modules`, pinned to 0.85.0.
Provider login is only needed for model requests, not extension status.
A pinned development dependency on `@earendil-works/pi-server` works around
Pi 0.85.0's missing CLI dependency; the extension itself does not use the server.

Without direnv:

```sh
devenv shell
npm ci
npm run dev
```

`devenv.nix` selects Node.js 24 and provides npm, Git, GitHub CLI, jq,
ripgrep, nixfmt, ShellCheck, and actionlint. `devenv.lock` pins Nix inputs;
`package-lock.json` pins npm dependencies. Shell entry does not install npm packages.
No separate `flake.nix` is needed: devenv manages the Nix environment.

```sh
repo-check            # TypeScript, formatting, tests, package contents, Nix/shell/CI lint
npm run test:watch
npm run format        # Format TypeScript, JSON, YAML, Markdown
nixfmt devenv.nix
```

`devenv test` installs locked npm dependencies and runs `repo-check`.
Outside Nix, Node.js >=22.19.0 can run `npm ci`, `npm run check`, and `npm run pack:check`.

For hot reload, install this checkout as a local Pi package:

```sh
pi install /absolute/path/to/pi-kiwifs-memory
```

Start Pi, edit source, then run `/reload`. Remove the local installation when done:

```sh
pi remove /absolute/path/to/pi-kiwifs-memory
```

Do not also use `-e` while the same extension is installed locally.

## Layout

- `src/index.ts`: Pi extension entry point, session runtime and command wiring.
- `src/config/`, `src/scope/`, `src/backend/`, `src/privacy/`, `src/outbox/`,
  `src/pi/`, `src/observation/`, `src/retrieval/`, `src/inject/`,
  `src/backup/`, `src/board/`, `src/runtime/`, `src/domain/`: feature modules.
- `test/`: offline test suite (472 tests), including the fault matrix,
  budget/quality baselines and long-session bounding audits. The live
  integration suite is opt-in: `KIWIFS_LIVE_TESTS=1 npm run test:live`.
- `scripts/check-package.mjs`: verifies the npm package file allowlist.
- `scripts/smoke-package.mjs`: packs the extension and loads it in an
  isolated Pi RPC process (no user credentials or installed extensions)
  with no backend configured, asserting command registration and a safe
  offline startup.
- `devenv.nix`, `devenv.yaml`, `.envrc`: Nix development environment.
- `.github/workflows/ci.yml`: Node compatibility and Nix checks.
- `.github/workflows/publish.yml`: release-triggered npm trusted publishing.
- [Configuration guide](docs/configuration.md), [operations guide](docs/operations.md),
  [privacy notes](docs/privacy.md), [memory lifecycle](docs/memory-lifecycle.md),
  [architecture](docs/architecture.md), [decisions](docs/decisions.md),
  [publishing research and release steps](docs/publishing.md).

Pi loads TypeScript directly, so releases ship `src/`, not a compiled bundle.
Runtime dependencies must go in `dependencies`; development tools belong in
`devDependencies`. Pi supplies its own core packages at runtime.

## Known limitations

Read before trusting this extension with anything you cannot afford to
leak. These are documented behavior, not aspirational TODOs.

- **Redaction is best effort.** Pattern and entropy scanning misses
  unrecognized secret formats and low-entropy secrets, and over-redacts
  random-looking identifiers. `docs/privacy.md` details the limits.
- **No reliable bundled tokenizer.** Automatic injection requires a
  user-supplied model-compatible tokenizer; without one, injection is
  skipped visibly. Synthetic tokenizers used in tests are not valid for
  production models.
- **Semantic search under-recall is permanent** (backend design): scope
  filtering happens after candidate selection server-side, and superseded
  or deleted records can surface from vector legs; read-back guards reject
  them, and keyword-only hybrid results are disclosed as degraded, never
  counted as semantic evidence.
- **The MCP transport must be network-protected.** Authentication is a
  bearer apikey on the authenticated `/mcp` endpoint; standalone MCP ports
  are unauthenticated. The extension's own credential handling proves
  nothing about server-side enforcement.
- **Erasure is reversible forgetting only.** No remote delete, no automatic
  erasure, no automatic board GC. A true purge is a manual operator
  procedure against backend storage, with no secure-erasure guarantee;
  git history and search indexes retain content regardless.
- **Backups are redacted and not byte-identical.** Restoring a backup back
  into Pi sessions is deferred and not attempted.
- **Board recipient labels are not confidentiality.** Anyone holding the
  shared backend key can read any channel. There are no TTL or push
  primitives; delivery is polling-based.
- **Coexistence with other memory extensions is untested.**
- **Not yet published.** No npm release or tag exists; publication happens
  only after the documented release procedure and explicit approval.

## Safety

Pi extensions run with your full user permissions. Review extensions before installing them.
Nix and devenv provide development tools, not a sandbox for extension execution.
Do not commit credentials, Pi session history, or memory data. `.pi/`, `.env*`,
and `.npmrc` are ignored; npm publishes only the file allowlist in `package.json`.
Add `.kiwifs/` to your project's `.gitignore` yourself (step 2 above); the
package allowlist cannot ship local state because it lists only `src/`.

## License

[MIT](LICENSE).
