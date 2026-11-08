// Moving over and staying up: `mcpgw init` (importing client configs), `mcpgw service` (starting
// at login), and the .env beside the config that both rely on.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { loadEnvFile, parseConfig } from "../src/config.js";
import { applyInit, clientFiles, describePlan, planInit, serverKey } from "../src/init.js";
import { servicePlan } from "../src/service.js";

function home() {
  const root = mkdtempSync(join(tmpdir(), "mcpgw-setup-"));
  const write = (path: string, body: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2));
  };
  const files = clientFiles(root, "linux");
  const at = (kind: string) => files.find((f) => f.kind === kind)!.path;
  write(at("claude-desktop"), {
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_desktop" } },
      "My Files": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/code"] },
    },
  });
  write(at("cursor"), {
    mcpServers: {
      // The same server as Claude Desktop's: imported once.
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_desktop" } },
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_secret" } },
      broken: { note: "neither command nor url" },
    },
  });
  write(at("claude-code"), {
    numStartups: 42,
    mcpServers: {
      // Already the gateway: neither imported nor duplicated.
      gateway: { type: "http", url: "http://127.0.0.1:8420/mcp/default" },
      slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" } },
    },
  });
  const configDir = join(root, "gw");
  mkdirSync(configDir);
  return { root, files, at, configPath: join(configDir, "config.yaml") };
}

const plan = (h: ReturnType<typeof home>, rewriteClients = true) =>
  planInit({ configPath: h.configPath, files: h.files, profile: "default", rewriteClients, node: "/usr/bin/node", bridge: "/opt/mcpgw/bridge.js" });

test("init plans an import without writing anything", () => {
  const h = home();
  const p = plan(h);
  assert.deepEqual(p.add.map((s) => s.name).sort(), ["github", "linear", "my-files", "slack"]);
  assert.deepEqual(p.add.find((s) => s.name === "github")!.from, ["claude-desktop", "cursor"]);
  assert.deepEqual(p.env, { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_desktop", LINEAR_AUTHORIZATION: "Bearer lin_secret" });
  assert.deepEqual(p.unset, ["SLACK_BOT_TOKEN"], "a reference the client already used must be set by hand");
  assert.ok(p.clients.find((c) => c.file.kind === "cursor")!.skipped.some((s) => s.name === "broken"));
  assert.equal(p.rewrite.length, 3);
  assert.match(describePlan(p), /Nothing has been written/);
  assert.equal(existsSync(h.configPath), false);
});

test("init writes a valid config, keeps secrets in .env, and repoints clients with backups", () => {
  const h = home();
  const { written, problems } = applyInit(plan(h));
  assert.deepEqual(problems, []);
  assert.ok(written.includes(h.configPath));

  const env = parseEnv(readFileSync(join(h.root, "gw", ".env"), "utf8"));
  assert.equal(env.LINEAR_AUTHORIZATION, "Bearer lin_secret");
  const yaml = readFileSync(h.configPath, "utf8");
  assert.doesNotMatch(yaml, /ghp_desktop|lin_secret/, "no secret lands in config.yaml");
  process.env.SLACK_BOT_TOKEN = "x";
  try {
    loadEnvFile(h.configPath);
    const cfg = parseConfig(yaml, h.configPath);
    assert.deepEqual(Object.keys(cfg.servers).sort(), ["github", "linear", "my-files", "slack"]);
    assert.deepEqual(cfg.profiles.default!.servers, ["*"]);
  } finally {
    for (const k of ["SLACK_BOT_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "LINEAR_AUTHORIZATION"]) delete process.env[k];
  }

  const code = JSON.parse(readFileSync(h.at("claude-code"), "utf8"));
  assert.equal(code.numStartups, 42, "the rest of the client's file is kept");
  assert.deepEqual(Object.keys(code.mcpServers), ["gateway"]);
  const desktop = JSON.parse(readFileSync(h.at("claude-desktop"), "utf8"));
  assert.deepEqual(desktop.mcpServers.gateway, { command: "/usr/bin/node", args: ["/opt/mcpgw/bridge.js", "--url", "http://127.0.0.1:8420/mcp/default"] });
  const cursor = JSON.parse(readFileSync(h.at("cursor"), "utf8"));
  assert.ok(cursor.mcpServers.broken, "what was not imported stays in the client");
  assert.ok(existsSync(`${h.at("cursor")}.mcpgw-backup`));

  // A second run finds the gateway everywhere and nothing new to add.
  const again = plan(h);
  assert.equal(again.add.length, 0);
  assert.equal(again.clients.every((c) => c.imported.length === 0), true);
});

test("init merges into an existing config without losing its comments", () => {
  const h = home();
  writeFileSync(
    h.configPath,
    "# my gateway\nversion: 1\nservers:\n  # the one I added by hand\n  github:\n    transport: stdio\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-github\"]\nprofiles:\n  default:\n    servers: [\"*\"]\n",
  );
  const p = plan(h, false);
  assert.ok(p.already.some((a) => a.existing === "github"), "the same server under its existing name");
  assert.ok(!p.add.some((s) => s.name.startsWith("github")));
  process.env.SLACK_BOT_TOKEN = "x";
  try {
    applyInit(p);
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
  }
  const yaml = readFileSync(h.configPath, "utf8");
  assert.match(yaml, /# my gateway/);
  assert.match(yaml, /# the one I added by hand/);
  assert.match(yaml, /linear:/);
  assert.ok(existsSync(`${h.configPath}.bak`));
});

test("init refuses to put a token into client files", () => {
  const h = home();
  writeFileSync(h.configPath, "version: 1\nlisten: { token: aaaaaaaaaaaaaaaa }\nservers: {}\nprofiles: { default: {} }\n");
  const p = plan(h);
  assert.equal(p.rewrite.length, 0);
  assert.match(p.rewriteBlocked!, /token/);
});

test("server names are made config-safe", () => {
  assert.equal(serverKey("My Files!"), "my-files");
  assert.equal(serverKey("a__b"), "a-b");
  assert.equal(serverKey("___"), "server");
});

test(".env fills in what the environment lacks, and never overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpgw-env-"));
  writeFileSync(join(dir, ".env"), "MCPGW_T_ONE=from-file\nMCPGW_T_TWO=from-file\n");
  process.env.MCPGW_T_TWO = "from-shell";
  try {
    assert.deepEqual(loadEnvFile(join(dir, "config.yaml")), ["MCPGW_T_ONE"]);
    assert.equal(process.env.MCPGW_T_ONE, "from-file");
    assert.equal(process.env.MCPGW_T_TWO, "from-shell");
  } finally {
    delete process.env.MCPGW_T_ONE;
    delete process.env.MCPGW_T_TWO;
  }
});

const input = (platform: NodeJS.Platform) => ({
  platform,
  home: "/home/ana",
  appData: "C:\\Users\\Ana\\AppData\\Roaming",
  uid: 501,
  node: "/usr/bin/node",
  cli: "/opt/mcp gateway/cli.js",
  config: "/home/ana/gw/config.yaml",
  log: "/home/ana/gw/mcpgw.log",
  name: "mcp-gateway",
});

test("service: a launchd agent on macOS", () => {
  const p = servicePlan(input("darwin"));
  assert.equal(p.file, join("/home/ana", "Library", "LaunchAgents", "dev.mcpgw.mcp-gateway.plist"));
  assert.match(p.content, /<string>\/opt\/mcp gateway\/cli.js<\/string>/);
  assert.match(p.content, /<string>--log<\/string>/);
  assert.deepEqual(p.install[0], ["launchctl", "bootstrap", "gui/501", p.file]);
});

test("service: a systemd user unit on Linux", () => {
  const p = servicePlan(input("linux"));
  assert.equal(p.file, join("/home/ana", ".config", "systemd", "user", "mcp-gateway.service"));
  assert.match(p.content, /ExecStart="\/usr\/bin\/node" "\/opt\/mcp gateway\/cli.js" "start" "--config"/);
  assert.deepEqual(p.install.at(-1), ["systemctl", "--user", "enable", "--now", "mcp-gateway.service"]);
});

test("service: a hidden launcher in the Startup folder on Windows", () => {
  const p = servicePlan(input("win32"));
  assert.match(p.file, /Start Menu[\\/]Programs[\\/]Startup[\\/]mcp-gateway\.vbs$/);
  // Each argument quoted, so a path with spaces survives; window style 0 is hidden.
  assert.match(p.content, /Run """\/usr\/bin\/node"" ""\/opt\/mcp gateway\/cli.js"" ""start""/);
  assert.match(p.content, /, 0, False/);
  assert.deepEqual(p.install[0], ["wscript.exe", p.file]);
});
