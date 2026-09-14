// Editing config.yaml for the status page: each edit must change only the lines it means to, in
// whatever layout the file was written, and a file it cannot change safely must be left alone.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError } from "../src/config.js";
import { LayoutError, setServerDisabled, setToolDenied } from "../src/configfile.js";

function file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "mcpgw-edit-")), "config.yaml");
  writeFileSync(path, text);
  return path;
}

const HEAD = `version: 1

# servers, as the user wrote them
servers:
  alpha:                 # the fixture
    transport: stdio
    command: node        # aligned comment
    env:
      TOKEN: \${MCPGW_EDIT_TEST_TOKEN}

  beta: { transport: stdio, command: node }
`;

process.env.MCPGW_EDIT_TEST_TOKEN = "not-written-anywhere";

test("disabling a block-style server inserts one line and leaves every comment where it was", () => {
  const path = file(`${HEAD}profiles:\n  p: { servers: ["*"] }\n`);
  const config = setServerDisabled(path, "alpha", true);

  assert.equal(
    readFileSync(path, "utf8"),
    HEAD.replace("  alpha:                 # the fixture\n", "  alpha:                 # the fixture\n    disabled: true\n") +
      `profiles:\n  p: { servers: ["*"] }\n`,
  );
  assert.deepEqual(config.disabled, ["alpha"]);
  assert.ok(!("alpha" in config.servers), "a disabled server must not reach the pool");
  assert.ok(readFileSync(path, "utf8").includes("${MCPGW_EDIT_TEST_TOKEN}"), "the env reference was expanded");
  assert.equal(readFileSync(`${path}.bak`, "utf8"), `${HEAD}profiles:\n  p: { servers: ["*"] }\n`);
});

test("enabling flips the existing value instead of rewriting the entry", () => {
  const path = file(`${HEAD}profiles:\n  p: { servers: ["*"] }\n`);
  setServerDisabled(path, "alpha", true);
  const config = setServerDisabled(path, "alpha", false);
  assert.match(readFileSync(path, "utf8"), /alpha: {17}# the fixture\n {4}disabled: false\n/);
  assert.deepEqual(config.disabled, []);
  assert.ok("alpha" in config.servers);
});

test("a flow-style server gets its flag inside the braces", () => {
  const path = file(`${HEAD}profiles:\n  p: { servers: ["*"] }\n`);
  setServerDisabled(path, "beta", true);
  assert.match(readFileSync(path, "utf8"), /\n {2}beta: \{ disabled: true, transport: stdio, command: node \}\n/);
});

test("a profile naming a disabled server is still valid", () => {
  const path = file(`${HEAD}profiles:\n  p:\n    servers: [alpha, beta]\n`);
  const config = setServerDisabled(path, "alpha", true);
  assert.deepEqual(config.profiles.p?.servers, ["alpha", "beta"]);
});

const denyCases: Array<{ name: string; before: string; after: string }> = [
  {
    name: "no deny list yet: one is added as the profile's first key",
    before: `  p:\n    servers: ["*"]   # all of them\n`,
    after: `  p:\n    deny: ["alpha__echo"]\n    servers: ["*"]   # all of them\n`,
  },
  {
    name: "a flow list gains an item after its last",
    before: `  p:\n    servers: ["*"]\n    deny: ["beta__*"]  # keep this\n`,
    after: `  p:\n    servers: ["*"]\n    deny: ["beta__*", "alpha__echo"]  # keep this\n`,
  },
  {
    name: "padding inside the brackets is kept",
    before: `  p:\n    servers: ["*"]\n    deny: [ beta__x ]\n`,
    after: `  p:\n    servers: ["*"]\n    deny: [ beta__x, "alpha__echo" ]\n`,
  },
  {
    name: "an empty flow list gets its first item",
    before: `  p:\n    servers: ["*"]\n    deny: []\n`,
    after: `  p:\n    servers: ["*"]\n    deny: ["alpha__echo"]\n`,
  },
  {
    name: "a block list gains a line lined up with the others, below a commented last item",
    before: `  p:\n    servers: ["*"]\n    deny:\n      - beta__x   # why\n    rename: {}\n`,
    after: `  p:\n    servers: ["*"]\n    deny:\n      - beta__x   # why\n      - "alpha__echo"\n    rename: {}\n`,
  },
];

for (const c of denyCases) {
  test(`deny: ${c.name}`, () => {
    const path = file(`${HEAD}profiles:\n${c.before}`);
    const config = setToolDenied(path, "p", "alpha__echo", true);
    assert.equal(readFileSync(path, "utf8"), `${HEAD}profiles:\n${c.after}`);
    assert.ok(config.profiles.p?.deny.includes("alpha__echo"));

    // And back: removing the entry again must restore a list meaning what it meant before.
    const restored = setToolDenied(path, "p", "alpha__echo", false);
    assert.ok(!restored.profiles.p?.deny.includes("alpha__echo"));
  });
}

const allowCases: Array<{ name: string; before: string; after: string }> = [
  { name: "first of several in a flow list", before: `deny: ["alpha__echo", "beta__x"]`, after: `deny: ["beta__x"]` },
  { name: "last of several in a flow list", before: `deny: [beta__x, "alpha__echo"]`, after: `deny: [beta__x]` },
  { name: "the only one in a flow list", before: `deny: ["alpha__echo"]`, after: `deny: []` },
  {
    name: "one line of a block list",
    before: `deny:\n      - beta__x\n      - alpha__echo  # temporary\n      - beta__y`,
    after: `deny:\n      - beta__x\n      - beta__y`,
  },
  { name: "the only line of a block list", before: `deny:\n      - alpha__echo`, after: `deny: []` },
];

for (const c of allowCases) {
  test(`allow again: ${c.name}`, () => {
    const path = file(`${HEAD}profiles:\n  p:\n    ${c.before}\n    servers: ["*"]\n`);
    setToolDenied(path, "p", "alpha__echo", false);
    assert.equal(readFileSync(path, "utf8"), `${HEAD}profiles:\n  p:\n    ${c.after}\n    servers: ["*"]\n`);
  });
}

test("a glob is never removed: only the exact entry the page added", () => {
  const text = `${HEAD}profiles:\n  p:\n    servers: ["*"]\n    deny: ["alpha__*"]\n`;
  const path = file(text);
  setToolDenied(path, "p", "alpha__echo", false);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.ok(!existsSync(`${path}.bak`), "nothing changed, so nothing was written");
});

test("an edit that makes the config invalid is refused and the file is untouched", () => {
  // Denying a tool the profile renames is a cross-check error: the alias could never be exposed.
  const text = `${HEAD}profiles:\n  p:\n    servers: ["*"]\n    rename: { alpha__echo: shout }\n`;
  const path = file(text);
  assert.throws(() => setToolDenied(path, "p", "alpha__echo", true), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.problems.join("\n"), /denied by this profile/);
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), text);
  assert.ok(!existsSync(`${path}.bak`));
});

test("a layout the splice cannot handle is refused rather than guessed at", () => {
  const text = `${HEAD}profiles:\n  p:\n    servers: ["*"]\n    deny: "alpha__echo"\n`;
  const path = file(text);
  assert.throws(() => setToolDenied(path, "p", "beta__x", true), LayoutError);
  assert.equal(readFileSync(path, "utf8"), text);
});
