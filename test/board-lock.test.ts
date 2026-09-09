/**
 * T18: shared-consumer safety — the consumer lock refuses a second live
 * writer visibly, reclaims only stale locks, and releases cleanly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireConsumerLock,
  ConsumerLockError,
  writeLockFileForTest,
} from "../src/board/lock.ts";
import { BoardDeliveryRuntime } from "../src/board/runtime.ts";
import { DeliveryStateFile } from "../src/board/delivery.ts";
import type { BoardRepository } from "../src/board/repository.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "kiwifs-lock-"));
}

const fakeRepo = {} as BoardRepository;

test("first acquirer owns the lock; second live acquirer is refused visibly", () => {
  const dir = freshDir();
  const lock = acquireConsumerLock(dir, "alpha");
  try {
    assert.throws(
      () => acquireConsumerLock(dir, "alpha"),
      (err: unknown) => {
        assert.ok(err instanceof ConsumerLockError);
        assert.match(err.message, /already held by pid/);
        assert.match(err.message, /distinct board\.consumerId/);
        assert.equal(err.holderPid, process.pid);
        return true;
      },
    );
  } finally {
    lock.release();
  }
  // After release, re-acquisition succeeds.
  const again = acquireConsumerLock(dir, "alpha");
  again.release();
});

test("a dead holder's lock is reclaimed", () => {
  const dir = freshDir();
  // pid 4_000_000 is far above any real pid ceiling on Linux (pid_max
  // default ≤ 4_194_304) and cannot be alive here.
  writeLockFileForTest(dir, "beta", 4_000_000);
  const lock = acquireConsumerLock(dir, "beta");
  assert.ok(existsSync(lock.path));
  lock.release();
  assert.equal(existsSync(lock.path), false);
});

test("invalid consumerId is refused before touching the filesystem", () => {
  const dir = freshDir();
  assert.throws(() => acquireConsumerLock(dir, "../escape"), ConsumerLockError);
});

test("BoardDeliveryRuntime holds visibly and never starts the poller when the consumer is locked", async () => {
  const dir = freshDir();
  const outer = acquireConsumerLock(dir, "shared");
  const state = new DeliveryStateFile(dir, "shared");
  const rt = new BoardDeliveryRuntime({
    stateDir: dir,
    consumerId: "shared",
    repo: fakeRepo,
    isPrivate: () => false,
    now: () => 1_000,
  });
  rt.start();
  try {
    const hold = rt.holdReason;
    assert.ok(hold, "runtime must report a hold reason");
    assert.match(hold, /already held by pid/);
    const s = rt.statusSnapshot();
    assert.equal(s.holdReason, hold);
    // No poller: no state file mutation beyond the initial construction.
    assert.equal(Object.keys(state.value.entries).length, 0);
  } finally {
    rt.stop();
    outer.release();
  }
  // After the holder releases, the runtime can start for real.
  rt.start();
  try {
    assert.equal(rt.holdReason, undefined);
  } finally {
    rt.stop();
  }
});

test("stop() releases the lock so a later session can take over", () => {
  const dir = freshDir();
  const state = new DeliveryStateFile(dir, "solo");
  const rt = new BoardDeliveryRuntime({
    stateDir: dir,
    consumerId: "solo",
    repo: fakeRepo,
    isPrivate: () => false,
    now: () => 1_000,
  });
  rt.start();
  rt.stop();
  const next = acquireConsumerLock(dir, "solo");
  next.release();
  assert.ok(state);
});
