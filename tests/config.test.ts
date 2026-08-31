import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "mcpgw-"));

/** Writes `yaml` to a temp file and returns the problems `loadConfig` reports. */
function problemsOf(name: string, yaml: string): string[] {
  const path = join(scratch, `${name}.yaml`);
  writeFileSync(path, yaml);
  try {
    loadConfig(path);
    return [];
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${e}`);
    return e.problems;
  }
}

const base = `
version: 1
servers:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
`;

test("accepts the SPEC 1.2 sample config", () => {
  process.env.GITHUB_TOKEN = "ghp_test";
  process.env.LINEAR_KEY = "lin_test";
  const { config } = loadConfig(join(repoRoot, "config.yaml"));

  assert.equal(config.listen.port, 8420);
  assert.deepEqual(Object.keys(config.servers), ["github", "fs", "linear", "legacy"]);
  const github = config.servers.github;
  assert.equal(github?.transport, "stdio");
  assert.equal(github?.transport === "stdio" && github.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_test");
  assert.ok(github?.transport === "stdio" && !github.cwd?.startsWith("~"), "~ in cwd is expanded");
  assert.equal(config.profiles.coding?.limits.rpm, 60);
  assert.equal(config.profiles.coding?.rename.github__create_issue, "file_bug");
  // defaults applied where the sample omits them
  assert.equal(config.profiles.default?.limits.concurrent, 8);
});

test("missing env var is fatal and names the key", () => {
  delete process.env.NOPE_UNSET;
  const problems = problemsOf("missing-env", `${base}    env: { TOKEN: \${NOPE_UNSET} }\nprofiles:\n  default: {}\n`);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /NOPE_UNSET/);
});

test("unknown server in a profile", () => {
  const problems = problemsOf("unknown-server", `${base}profiles:\n  default:\n    servers: [github, ghost]\n`);
  assert.deepEqual(problems, ['profiles.default.servers: unknown server "ghost"']);
});

test("rename collision", () => {
  const problems = problemsOf(
    "rename-collision",
    `${base}profiles:\n  default:\n    rename:\n      github__create_issue: file_bug\n      github__create_pull_request: file_bug\n`,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /both map to "file_bug"/);
});

test("rename of a tool the profile never exposes", () => {
  const problems = problemsOf(
    "rename-denied",
    `${base}profiles:\n  default:\n    deny: ["github__delete_*"]\n    rename:\n      github__delete_repo: nuke\n      linear__list_issues: issues\n`,
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /denied by this profile/);
  assert.match(problems[1]!, /server "linear" is not in this profile/);
});

test("non-loopback host without a token", () => {
  const problems = problemsOf(
    "open-bind",
    `${base}profiles:\n  default: {}\nlisten:\n  host: 0.0.0.0\n`,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /NFR-2/);

  assert.deepEqual(
    problemsOf("open-bind-token", `${base}profiles:\n  default: {}\nlisten:\n  host: 0.0.0.0\n  token: secret\n`),
    [],
  );
});

test("every problem is reported at once", () => {
  const problems = problemsOf(
    "many",
    `${base}  bad__key:\n    transport: stdio\n    command: x\nprofiles:\n  default:\n    servers: [ghost]\nlisten:\n  host: 0.0.0.0\n`,
  );
  assert.equal(problems.length, 3, problems.join("\n"));
});

test("invalid redact pattern", () => {
  const problems = problemsOf(
    "bad-regex",
    `${base}profiles:\n  default: {}\nguard:\n  redact: ["(?i)bearer [a-z]+", "[unclosed"]\n`,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /guard\.redact\[1\]/);
});
