import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter } from "../src/ratelimit.js";

/** A clock the test moves by hand — the refill maths must not depend on wall time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("the bucket starts full and empties one call at a time", () => {
  const c = clock();
  const limiter = new Limiter(3, 10, c.now);
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.acquire().ok, true, `call ${i + 1} should pass`);
    limiter.release();
  }
  assert.equal(limiter.acquire().ok, false);
});

test("it refills continuously, not in steps", () => {
  const c = clock();
  const limiter = new Limiter(60, 10, c.now); // one token per second
  for (let i = 0; i < 60; i++) {
    limiter.acquire();
    limiter.release();
  }
  assert.equal(limiter.acquire().ok, false);

  c.advance(500);
  assert.equal(limiter.acquire().ok, false, "half a token is not a token");
  c.advance(500);
  assert.equal(limiter.acquire().ok, true, "one second buys exactly one call");
});

test("it never banks more than the capacity", () => {
  const c = clock();
  const limiter = new Limiter(5, 10, c.now);
  c.advance(60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.acquire().ok, true);
    limiter.release();
  }
  assert.equal(limiter.acquire().ok, false, "an idle hour must not buy an unbounded burst");
});

test("rejection says when to come back", () => {
  const c = clock();
  const limiter = new Limiter(60, 10, c.now);
  for (let i = 0; i < 60; i++) {
    limiter.acquire();
    limiter.release();
  }
  const grant = limiter.acquire();
  assert.equal(grant.ok, false);
  assert.equal(grant.ok === false && grant.retryAfterMs, 1000);
});

test("the semaphore caps concurrency and is checked before the bucket", () => {
  const c = clock();
  const limiter = new Limiter(100, 2, c.now);
  assert.equal(limiter.acquire().ok, true);
  assert.equal(limiter.acquire().ok, true);
  assert.equal(limiter.acquire().ok, false);
  assert.equal(limiter.inflight, 2);

  limiter.release();
  assert.equal(limiter.acquire().ok, true);
});

test("a rejected call consumes neither a slot nor a token", () => {
  const c = clock();
  const limiter = new Limiter(10, 1, c.now);
  assert.equal(limiter.acquire().ok, true);
  for (let i = 0; i < 5; i++) assert.equal(limiter.acquire().ok, false);
  limiter.release();

  // The five rejections must not have eaten into the nine remaining tokens.
  for (let i = 0; i < 9; i++) {
    assert.equal(limiter.acquire().ok, true, `token ${i + 1} should still be there`);
    limiter.release();
  }
  assert.equal(limiter.acquire().ok, false);
});

test("release in a finally keeps a throwing call from leaking its slot", async () => {
  const limiter = new Limiter(100, 1);
  const call = async () => {
    assert.equal(limiter.acquire().ok, true);
    try {
      throw new Error("backend exploded");
    } finally {
      limiter.release();
    }
  };
  await assert.rejects(call());
  assert.equal(limiter.inflight, 0);
  assert.equal(limiter.acquire().ok, true);
});

test("a restored bucket carries its tokens, and refills from when it was saved", () => {
  const c = clock();
  const before = new Limiter(60, 10, c.now);
  for (let i = 0; i < 60; i++) {
    before.acquire();
    before.release();
  }
  const saved = before.snapshot();

  c.advance(2000); // the daemon was down for two seconds
  const after = new Limiter(60, 10, c.now);
  after.restore(saved);
  assert.equal(after.acquire().ok, true);
  after.release();
  assert.equal(after.acquire().ok, true);
  after.release();
  assert.equal(after.acquire().ok, false, "two seconds bought two calls, not a full bucket");
});

test("a snapshot taken under different limits is ignored", () => {
  const c = clock();
  const old = new Limiter(1, 10, c.now);
  old.acquire();
  const fresh = new Limiter(100, 10, c.now);
  fresh.restore(old.snapshot());
  for (let i = 0; i < 100; i++) {
    assert.equal(fresh.acquire().ok, true);
    fresh.release();
  }
});

test("an unset bound is unlimited", () => {
  const limiter = new Limiter(Infinity, 1);
  assert.equal(limiter.acquire().ok, true);
  assert.equal(limiter.acquire().ok, false, "the concurrency bound still holds");
  limiter.release();
  for (let i = 0; i < 1000; i++) {
    assert.equal(limiter.acquire().ok, true);
    limiter.release();
  }
});
