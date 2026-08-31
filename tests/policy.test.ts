import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProfileConfig } from "../src/config.js";
import { decide, serverOf, type Decision, type Facts } from "../src/policy.js";

/** Flattens a decision to one comparable label. */
const verdict = (d: Decision) => (d.allow ? "allow" : d.reason);

const profile = (over: Partial<ProfileConfig> = {}): ProfileConfig => ({
  servers: ["*"],
  deny: [],
  rename: {},
  limits: { rpm: 120, concurrent: 8 },
  ...over,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  profile: profile(),
  serverState: "up",
  drifted: false,
  onDrift: "block",
  ...over,
});

test("step 1 — an unknown profile denies", () => {
  const d = decide("gh__get_issue", facts({ profile: undefined }));
  assert.deepEqual(d, { allow: false, reason: "unknown_profile", rule: "no such profile" });
});

test("step 2 — a server outside the profile denies", () => {
  const p = profile({ servers: ["fs"] });
  assert.equal(decide("gh__get_issue", facts({ profile: p })).allow, false);
  assert.equal(decide("fs__read", facts({ profile: p })).allow, true);
  // "*" reaches everything
  assert.equal(decide("gh__get_issue", facts({ profile: profile({ servers: ["*"] }) })).allow, true);
});

test("step 3 — deny beats allow, always", () => {
  const p = profile({ allow: ["gh__*"], deny: ["gh__delete_*"] });
  const d = decide("gh__delete_repo", facts({ profile: p }));
  assert.equal(verdict(d), "denied_by_policy");
  assert.equal(d.rule, "deny: gh__delete_*");
});

test("step 4 — with an allow list, no match denies", () => {
  const p = profile({ allow: ["gh__get_*", "gh__list_*"] });
  assert.equal(decide("gh__get_issue", facts({ profile: p })).allow, true);
  assert.equal(verdict(decide("gh__create_issue", facts({ profile: p }))), "not_allowed");
  // absent allow list means "everything not denied"
  assert.equal(decide("gh__create_issue", facts()).allow, true);
});

test("step 5 — a drifted tool is blocked, or merely flagged", () => {
  assert.equal(verdict(decide("gh__get_issue", facts({ drifted: true }))), "drift_blocked");
  assert.equal(decide("gh__get_issue", facts({ drifted: true, onDrift: "warn" })).allow, true);
});

test("step 6 — a backend that is not up denies", () => {
  for (const state of ["down", "connecting", undefined] as const) {
    assert.equal(
      verdict(decide("gh__get_issue", facts({ serverState: state }))),
      "server_unavailable",
      `state ${state} must deny`,
    );
  }
});

test("order is normative: deny is reported before an unavailable server", () => {
  const p = profile({ deny: ["gh__*"] });
  const d = decide("gh__get_issue", facts({ profile: p, serverState: "down", drifted: true }));
  assert.equal(verdict(d), "denied_by_policy");
});

test("globs: * spans __, ? is one character, and nothing else is special", () => {
  const g = (deny: string, name: string) =>
    decide(name, facts({ profile: profile({ deny: [deny] }) })).allow === false;

  assert.equal(g("*", "gh__anything"), true);
  assert.equal(g("gh__*", "gh__a__b"), true, "* must span __");
  assert.equal(g("gh__get_?", "gh__get_a"), true);
  assert.equal(g("gh__get_?", "gh__get_ab"), false);
  assert.equal(g("gh__a.b", "gh__axb"), false, ". is a literal, not a regex dot");
  assert.equal(g("gh__a+", "gh__a"), false, "+ is a literal");
  assert.equal(g("GH__get_x", "gh__get_x"), false, "matching is case-sensitive");
});

test("an alias is never what the globs see", () => {
  // The pipeline resolves file_bug -> gh__create_issue before asking; the deny list only ever
  // sees canonical names, so renaming cannot be used to slip past it.
  const p = profile({ deny: ["gh__create_*"], rename: { gh__create_issue: "file_bug" } });
  assert.equal(decide("gh__create_issue", facts({ profile: p })).allow, false);
  assert.equal(verdict(decide("file_bug", facts({ profile: p }))), "server_not_in_profile");
});

test("a name with no server prefix denies, even under a wildcard profile", () => {
  // Only names the catalog produced are namespaced; `*` must not be a way in for anything else.
  assert.equal(verdict(decide("no_namespace_here", facts())), "server_not_in_profile");
  assert.equal(verdict(decide("__leading", facts())), "server_not_in_profile");
});

test("serverOf splits on the first double underscore", () => {
  assert.equal(serverOf("gh__create_issue"), "gh");
  assert.equal(serverOf("gh__a__b"), "gh");
  assert.equal(serverOf("bare"), "");
});
