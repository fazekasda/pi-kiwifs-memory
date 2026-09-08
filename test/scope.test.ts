import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizedScopeSet,
  normalizeGitRemote,
  projectScope,
  resolveProjectIdentity,
  scopeIsAuthorized,
} from "../src/scope/identity.ts";

// ---------- normalizeGitRemote ----------

test("normalizes https remotes: strips scheme, credentials, port, .git", () => {
  assert.equal(
    normalizeGitRemote("https://github.com/org/repo.git"),
    "github.com/org/repo",
  );
  assert.equal(
    normalizeGitRemote("https://user:secret@github.com/org/repo.git"),
    "github.com/org/repo",
  );
  assert.equal(
    normalizeGitRemote("https://user:secret@github.com:8443/org/repo/"),
    "github.com/org/repo",
  );
  assert.equal(
    normalizeGitRemote("http://git.example.com/team/project.GIT"),
    "git.example.com/team/project",
  );
});

test("normalizes ssh and scp-like remotes", () => {
  assert.equal(
    normalizeGitRemote("git@github.com:org/repo.git"),
    "github.com/org/repo",
  );
  assert.equal(
    normalizeGitRemote("ssh://git@host.example.com:2222/srv/org/repo.git"),
    "host.example.com/org/repo",
  );
  assert.equal(normalizeGitRemote("git://host/repo.git"), "host/repo");
});

test("normalization is case-insensitive and stable across equivalent forms", () => {
  assert.equal(
    normalizeGitRemote("https://GitHub.com/Org/Repo.git"),
    normalizeGitRemote("git@github.com:org/repo"),
  );
});

test("rejects unparseable, unsupported and too-short remotes", () => {
  assert.throws(() => normalizeGitRemote(""), /empty/);
  assert.throws(
    () => normalizeGitRemote(":::"),
    /unparseable|unsupported|must contain/,
  );
  assert.throws(
    () => normalizeGitRemote("file:///some/path"),
    /unsupported remote scheme/,
  );
  // Credentials never appear in thrown messages.
  try {
    normalizeGitRemote("https://user:topsecret@host/own/repo");
  } catch (err) {
    assert.ok(!String((err as Error).message).includes("topsecret"));
  }
});

test("repo-only paths (no owner segment) still form a stable identity", () => {
  assert.equal(normalizeGitRemote("https://host/onlyrepo"), "host/onlyrepo");
});

// ---------- resolveProjectIdentity ----------

test("resolves a single remote to host/owner/repo", () => {
  const r = resolveProjectIdentity({
    remotes: { origin: "https://github.com/org/repo.git" },
  });
  assert.deepEqual(r, {
    ok: true,
    projectId: "github.com/org/repo",
    source: "git-remote",
  });
});

test("equivalent remotes (origin/upstream mirrors) are not ambiguous", () => {
  const r = resolveProjectIdentity({
    remotes: {
      origin: "https://github.com/org/repo.git",
      mirror: "git@github.com:org/repo",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.projectId, "github.com/org/repo");
});

test("worktrees and branches do not change identity (repo-level)", () => {
  // A worktree shares the same remote; branch names are never part of identity.
  const main = resolveProjectIdentity({
    remotes: { origin: "https://github.com/org/repo.git" },
  });
  const worktree = resolveProjectIdentity({
    remotes: { origin: "https://github.com/org/repo.git" },
  });
  assert.equal(
    main.ok && worktree.ok && main.projectId === worktree.projectId,
    true,
  );
});

test("conflicting remotes fail closed and demand an explicit override", () => {
  const r = resolveProjectIdentity({
    remotes: {
      origin: "https://github.com/org/repo.git",
      other: "https://gitlab.com/org/other.git",
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "ambiguous-remotes");
    assert.match(r.detail, /projectIdentity override/);
  }
});

test("non-Git directory (no remotes) fails closed without an override", () => {
  const r = resolveProjectIdentity({ remotes: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no-remotes");
});

test("explicit override wins for non-Git and ambiguous cases", () => {
  const nonGit = resolveProjectIdentity({ remotes: {} }, "local/team-project");
  assert.deepEqual(nonGit, {
    ok: true,
    projectId: "local/team-project",
    source: "override",
  });
  const ambiguous = resolveProjectIdentity(
    {
      remotes: {
        a: "https://github.com/org/a.git",
        b: "https://github.com/org/b.git",
      },
    },
    "github.com/org/a",
  );
  assert.equal(ambiguous.ok, true);
  if (ambiguous.ok) assert.equal(ambiguous.projectId, "github.com/org/a");
  const badOverride = resolveProjectIdentity({ remotes: {} }, "no slash here");
  assert.equal(badOverride.ok, false);
});

// ---------- scope resolution ----------

test("authorized scope set defaults to own project + personal; cross-project denied", () => {
  const r = authorizedScopeSet("github.com/org/repo", {
    allowPersonalGlobal: true,
    crossProjectOptIn: [],
  });
  assert.deepEqual(r, {
    ok: true,
    scopes: ["project/github.com/org/repo", "personal"],
  });
});

test("personal-global can be excluded; opt-in adds explicit cross values", () => {
  const r = authorizedScopeSet("github.com/org/repo", {
    allowPersonalGlobal: false,
    crossProjectOptIn: ["cross/gitlab.com/org/other"],
  });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(r.scopes, [
      "project/github.com/org/repo",
      "cross/gitlab.com/org/other",
    ]);
});

test("opt-in values must be explicit cross/ values", () => {
  const r = authorizedScopeSet("p", {
    allowPersonalGlobal: false,
    crossProjectOptIn: ["project/other"],
  });
  assert.equal(r.ok, false);
});

test("scope set exceeding the N≤4 fanout bound fails closed", () => {
  const r = authorizedScopeSet("p", {
    allowPersonalGlobal: true,
    crossProjectOptIn: ["cross/a", "cross/b", "cross/c"],
  });
  assert.equal(r.ok, false);
  const ok = authorizedScopeSet("p", {
    allowPersonalGlobal: true,
    crossProjectOptIn: ["cross/a", "cross/b"],
  });
  assert.equal(ok.ok, true);
});

test("record scope gate: exact membership in the authorized set only", () => {
  const authorized = ["project/github.com/org/repo", "personal"] as const;
  assert.equal(
    scopeIsAuthorized("project/github.com/org/repo", authorized),
    true,
  );
  assert.equal(scopeIsAuthorized("personal", authorized), true);
  // Cross-project record: denied by default.
  assert.equal(
    scopeIsAuthorized("project/gitlab.com/org/other", authorized),
    false,
  );
  assert.equal(
    scopeIsAuthorized("cross/github.com/org/repo", authorized),
    false,
  );
  // Prefix/suffix look-alikes are not memberships.
  assert.equal(
    scopeIsAuthorized("project/github.com/org/repo-extra", authorized),
    false,
  );
  assert.equal(scopeIsAuthorized("Personal", authorized), false);
});

test("project scope value format matches the record grammar", () => {
  assert.equal(
    projectScope("github.com/org/repo"),
    "project/github.com/org/repo",
  );
});
