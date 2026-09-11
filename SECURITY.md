# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security or privacy problem.

Use **GitHub private vulnerability reporting**: open the repository's
**Security** tab → **Report a vulnerability**. If that route is
unavailable for any reason, contact the maintainer directly at the
address on the GitHub profile of `fazekasda` and include the words
"pi-kiwifs-memory security report" in the subject so the message is
triaged quickly.

You should receive an acknowledgment within 7 days. Please do not
disclose the issue publicly until a fix is released and you are asked to
do so.

## What to include

- Extension version or commit, Pi version, Node.js version, and KiwiFS
  backend version.
- A sanitized description of the problem and how to reproduce it.
- Sanitized diagnostics only.

**Never include** credentials, tokens, backend URLs that embed
credentials, configuration files, raw session transcripts, or stored
memory contents in any report, in any channel.

## Prohibited content in all reports

Reports (public issues, private reports, discussions) must not contain:

- credentials, tokens, or API keys;
- configuration files or their contents;
- raw session transcripts or session excerpts;
- stored memory contents or memory record bodies;
- backend endpoint URLs containing embedded credentials.

Replace real values with placeholders such as `<REDACTED>` and describe
the _category_ of the content instead.

## In scope

- Redaction failures (unredacted content reaching a model call, backend
  write, query, queue, or audit log).
- Scope isolation failures between KiwiFS scopes.
- Private mode failing to hold all reads and writes.
- Forgetting/deletion behaving contrary to its documented guarantees
  (best-effort, reversible, not secure erasure).
- Injection handling: memory evidence is injected as untrusted,
  source-labeled data; failures of that labeling are in scope.

## Out of scope

- The KiwiFS backend itself; report those to the KiwiFS project.
- Model or provider-side issues on OpenRouter or other providers.
- Issues requiring a malicious, misconfigured, or compromised KiwiFS
  deployment beyond the documented trust model.
