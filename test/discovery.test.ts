/**
 * T18: git-remote project-identity discovery (synthetic only — no live git
 * required; output fixtures simulate `git remote -v`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverProjectIdentity,
  parseGitRemoteV,
} from "../src/scope/discovery.ts";

test("parseGitRemoteV takes fetch URLs and ignores push-only lines", () => {
  const remotes = parseGitRemoteV(
    [
      "origin\tgit@github.com:owner/repo.git (fetch)",
      "origin\tother@github.com:owner/other.git (push)",
      "upstream  https://gitlab.com/u/r.git (fetch)",
      "garbage line",
    ].join("\n"),
  );
  assert.deepEqual(remotes, {
    origin: "git@github.com:owner/repo.git",
    upstream: "https://gitlab.com/u/r.git",
  });
});

test("discovery resolves a single normalized remote", () => {
  const r = discoverProjectIdentity({
    cwd: "/tmp/unused",
    run: () => "origin\thttps://GitHub.com/Owner/Repo.git (fetch)\n",
  });
  assert.deepEqual(r, {
    ok: true,
    projectId: "github.com/owner/repo",
    source: "git-remote",
  });
});

test("discovery fails closed on zero remotes (non-Git)", () => {
  const r = discoverProjectIdentity({ cwd: "/tmp", run: () => "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no-remotes");
});

test("discovery fails closed on conflicting remotes", () => {
  const r = discoverProjectIdentity({
    cwd: "/tmp",
    run: () =>
      "a\thttps://github.com/o/r1.git (fetch)\nb\thttps://github.com/o/r2.git (fetch)\n",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "ambiguous-remotes");
});

test("discovery never leaks remote URLs in failure detail", () => {
  const r = discoverProjectIdentity({
    cwd: "/tmp",
    run: () => "origin\tssh://user:secret@/no-host.git (fetch)\n",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(!r.detail.includes("secret"), r.detail);
});

test("unavailable git fails closed with a sanitized reason", () => {
  const r = discoverProjectIdentity({
    cwd: "/tmp",
    run: () => {
      const e = new Error("git not found") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "unavailable");
    assert.ok(r.detail.includes("git is not available"));
  }
});
