import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalName, reaches } from "../src/catalog.js";

const none = new Set<string>();

test("namespaces server and tool", () => {
  assert.equal(canonicalName("github", "create_issue", none), "github__create_issue");
});

test("replaces characters outside the charset", () => {
  assert.equal(canonicalName("gh", "read file", none), "gh__read_file");
  assert.equal(canonicalName("gh", "a.b/c", none), "gh__a_b_c");
});

test("truncates over-long names to 120 plus a hash", () => {
  const name = canonicalName("srv", "x".repeat(200), none);
  assert.equal(name.length, 128);
  assert.match(name, /^srv__x{115}_[0-9a-f]{7}$/);
});

test("truncation is stable across calls", () => {
  const long = "y".repeat(200);
  assert.equal(canonicalName("srv", long, none), canonicalName("srv", long, none));
});

test("the same tool name on two servers does not collide", () => {
  const taken = new Set([canonicalName("a", "read", none)]);
  assert.equal(canonicalName("b", "read", taken), "b__read");
});

test("two tool names that sanitize alike are still distinguishable", () => {
  const first = canonicalName("s", "a b", none);
  const second = canonicalName("s", "a.b", new Set([first]));
  assert.equal(first, "s__a_b");
  assert.notEqual(second, first);
  assert.match(second, /^s__a_b_[0-9a-f]{7}$/);
});

test("profile server membership", () => {
  const profile = { servers: ["github"], deny: [], rename: {}, limits: { rpm: 1, concurrent: 1 } };
  assert.equal(reaches(profile, "github"), true);
  assert.equal(reaches(profile, "fs"), false);
  assert.equal(reaches({ ...profile, servers: ["*"] }, "fs"), true);
});
