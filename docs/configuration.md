# Configuration guide

How to configure the KiwiFS memory extension. Everything here is cross-checked
against `src/config/schema.ts` (schema v1) and `src/config/loader.ts`. The
config loader validates fail-closed: unknown keys, out-of-range values and
inline secrets are validation errors, never silent defaults.

## Where the config lives

The extension reads a JSON file whose path comes from the
`KIWIFS_MEMORY_CONFIG` environment variable. Without that variable set, or
with `enabled: false`, the extension loads in disabled state and does
nothing. Set the variable in the shell that launches Pi:

```sh
export KIWIFS_MEMORY_CONFIG="$HOME/.config/kiwifs/memory.json"
```

Local durable state (outbox queue, board delivery state, session coordinator
state, manual-op logs) is stored per project in `<project>/.kiwifs/memory/`
with `0700` permissions, or in the directory named by
`KIWIFS_MEMORY_STATE_DIR` when set. Add `.kiwifs/` to your project's
`.gitignore`; the queue contains redacted payloads and should never be
committed.

Precedence, lowest to highest: built-in defaults, the config file, runtime
overrides. The loader never resolves credential references to secret values.

## Minimal opt-in config

This example enables all three features (observation, backup, board) against
an apikey-authenticated MCP endpoint, with credentials referenced by
environment variable. Replace the URL with your own KiwiFS service. The
schema accepts exactly these keys; anything else fails validation.

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
  "scopes": { "allowPersonalGlobal": true, "crossProjectOptIn": [] },
  "budgets": {
    "ragDeadlineMs": 2000,
    "evidenceTokenCap": 3000,
    "tokenizer": { "module": "/abs/path/to/my-tokenizer.mjs" }
  },
  "features": { "observation": true, "backup": true, "board": true },
  "privacy": { "exclusions": [] },
  "board": { "consumerId": "laptop-1" }
}
```

Then export the secrets in the launching shell (never in the config file):

```sh
export KIWIFS_MCP_APIKEY="...your KiwiFS apikey..."
export OPENROUTER_API_KEY="...your OpenRouter key..."
```

A `file` credential reference is also supported, for example
`{ "kind": "file", "ref": "/run/secrets/kiwifs-apikey" }`. The path must be
absolute; the file holds the secret value.

## Field reference

### mcp

- `url`: the Streamable HTTP MCP endpoint of your KiwiFS service, including
  its real path. Must be `http(s)` and must not embed a username or password.
- `auth` (required when `enabled`): credential reference, `env` or `file`.
  Credentials are stored by reference; the resolved value never appears in
  the config, in status output or in logs.

Point this at an apikey-authenticated MCP endpoint (in the reference KiwiFS
deployment, `/mcp` on the main authenticated server). A standalone port-8181
MCP endpoint is unauthenticated by design; anyone who can reach the port can
read and write the backend. See `docs/operations.md` before exposing anything
to a network you do not control.

### model

- `route`: provider/model route used for observation extraction and
  reflection. Default `openrouter/z-ai/glm-5.3-flash`, user-configurable.
  There is no silent fallback to another model: if the configured model or
  its credential is unavailable, extraction fails closed with a visible
  availability error and pending work stays queued.
- `auth`: credential reference for the model provider, same shape as
  `mcp.auth`. Without it, extraction fails closed at call time; the config
  stays valid so `/kiwifs-status` still renders.

### scopes

- `allowPersonalGlobal` (default `true`): whether the `personal` scope is in
  the authorized scope set.
- `crossProjectOptIn`: explicit array of values like `"cross/other-project"`.
  Empty (the default) denies cross-project reads. Opt-in is per value, never
  blanket.

### budgets

- `ragDeadlineMs` (default `2000`): the total retrieval deadline in ms. It
  covers query build, all scope queries and packing. On expiry the extension
  injects nothing and logs a visible degradation; Pi continues normally.
- `evidenceTokenCap` (default `3000`): enforced token cap on the injected
  evidence pack, counted on the complete payload including framing and
  source citations.
- `tokenizer`: a module you supply, `{ "module": path, "export": name }`.
  See below. This is the only sanctioned way to enforce the cap; character
  estimation is never used for enforcement.

### Tokenizer requirement (important)

Automatic context injection enforces the 3,000-token cap with a tokenizer
compatible with your configured model. The extension ships **no bundled
tokenizer** for the default route. Your module must be an ES module exporting:

```js
export const tokenizer = {
  id: "my-model-tokenizer-v1",
  countTokens(text) {
    // return a token count, or `undefined` when the text cannot be
    // tokenized reliably (the caller then skips injection, fail closed)
  },
};
```

The default export name is `tokenizer`; override it with `budgets.tokenizer.export`.
If no tokenizer is configured, or the module fails to load or returns
`undefined`, automatic injection is skipped with a visible `tokenize:`
degradation note in `/kiwifs-status`. Explicit recall
(`kiwifs_memory_search`, `kiwifs_memory_read`) keeps working. This
requirement is deliberate (decisions.md #7, architecture.md §13 row 5):
without a reliable tokenizer the cap cannot be enforced, so injection is
never silently approximated. A synthetic word-counting module would produce
wrong counts against the real model; the extension treats unreliable counts
as failure, not as an estimate.

### features

`observation`, `backup`, `board`, each `true` by default. Private mode
overrides all three to off while it is active.

### privacy

`exclusions`: an array of rules with any of `project` (scope value),
`pathPrefix` (backend path prefix, whole-file) and `pattern` (content
regex). Dimensions are ANDed within a rule; rules are ORed. Content matching
an exclusion is never captured, so it never reaches a model call, a backend
write or the queue. An invalid regex fails validation at load. Redaction
itself is pattern plus entropy based and best effort; read
`docs/privacy.md` for its documented limits before trusting it with
high-value secrets.

### projectIdentity

Optional override like `"host/repo"` for non-Git projects or ambiguous
remotes. Otherwise project identity is discovered from the normalized git
remote. If neither resolves, observation and backup are held with a visible
`records: DISABLED` note rather than guessing.

### board

- `consumerId` (required for delivery): a stable id matching
  `[a-z0-9][a-z0-9_-]{0,63}`, naming the durable per-consumer delivery state
  file. Delivery is held visibly without it. Use one consumerId per
  machine/agent instance that polls the same channels; two consumers sharing
  an id contend on a local lock and one holds.
- `recipient` (optional): client-side routing label. Messages addressed to a
  different recipient are skipped as unauthorized. Labels route messages;
  they do not provide confidentiality from other holders of the shared
  backend key.
- `pollMs` (default 60000), `backoffMs` (default 60000 base, doubles per
  empty poll, capped at 15 min), `backlogPauseAt` (default 500 unread,
  range 1–10000). `pollMs` and `backoffMs` accept 5000–3600000. Values out
  of range are validation errors, never silently clamped. Pausing on
  backlog never drops messages; the backlog survives.

### schemaVersion

`1` is the only supported value. A newer version in the config is rejected
with a visible message and never rewritten destructively; an older version
is rejected with a pointer to the upgrade path.
