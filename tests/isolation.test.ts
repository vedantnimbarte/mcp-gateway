// Phase 8: one busy backend must not starve the others, repeated idempotent calls should not
// reach the backend, buckets survive a graceful restart, and a launcher's children do not leak.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuditLine } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { LIMITS_STATE } from "../src/ratelimit.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const launcher = fileURLToPath(new URL("./launcher.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-iso-"));
const configPath = join(dir, "config.yaml");
const pidFile = join(dir, "straggler.pid");

function writeConfig(alphaConcurrent: number): void {
  writeFileSync(
    configPath,
    `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    limits: { concurrent: ${alphaConcurrent} }
  bravo:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    cache:
      tools: ["sleep"]
      ttl_ms: 60000
profiles:
  all:
    servers: ["*"]
  stingy:
    servers: [bravo]
    limits: { rpm: 2 }
`,
  );
}

let gateway: Gateway;
let parts: Parts;
const clients: Client[] = [];

async function open(profile = "all", on = gateway): Promise<Client> {
  const client = new Client({ name: `iso-${profile}`, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${on.url}/mcp/${profile}`)));
  clients.push(client);
  return client;
}

async function start(): Promise<void> {
  const { config } = loadConfig(configPath);
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0, configPath });
  await parts.pool.start();
}

before(async () => {
  writeConfig(1);
  await start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

const rejectsWith = (reason: string, server?: string) =>
  (e: Error & { code?: number; data?: { reason?: string; server?: string } }) =>
    e.code === -32005 && e.data?.reason === reason && e.data?.server === server;

test("a server at its concurrency limit refuses more work, and its neighbours carry on", async () => {
  const client = await open();
  const busy = client.callTool({ name: "alpha__sleep", arguments: { ms: 500 } });
  await new Promise((r) => setTimeout(r, 100));

  await assert.rejects(
    client.callTool({ name: "alpha__sleep", arguments: { ms: 10 } }),
    rejectsWith("rate_limited", "alpha"),
  );
  // The refusal handed back the profile's slot: only the running call is counted.
  assert.equal(parts.pipeline.inflight, 1);

  const started = Date.now();
  await client.callTool({ name: "bravo__echo", arguments: { message: "not starved" } });
  assert.ok(Date.now() - started < 400, "bravo waited on alpha");
  await busy;
});

test("changing a server's limits on reload keeps its process", async () => {
  const pid = parts.pool.backends.get("alpha")!.pid;
  writeConfig(2);
  await gateway.reload(loadConfig(configPath).config);
  assert.equal(parts.pool.backends.get("alpha")!.pid, pid, "a limits-only change restarted alpha");

  const client = await open();
  const calls = [1, 2].map(() => client.callTool({ name: "alpha__sleep", arguments: { ms: 200 } }));
  await Promise.all(calls); // two at once now fit
});

test("a cached tool answers a repeated call without the backend", async () => {
  const client = await open();
  const slow = { name: "bravo__sleep", arguments: { ms: 300 } };

  let t = Date.now();
  await client.callTool(slow);
  assert.ok(Date.now() - t >= 280, "the first call must reach the backend");

  t = Date.now();
  assert.deepEqual(await client.callTool(slow), { content: [{ type: "text", text: "slept 300ms" }] });
  assert.ok(Date.now() - t < 150, `the repeat took ${Date.now() - t}ms`);

  t = Date.now();
  await client.callTool({ name: "bravo__sleep", arguments: { ms: 301 } });
  assert.ok(Date.now() - t >= 280, "different arguments are a different question");

  await parts.audit.flush();
  const lines = readFileSync(join(dir, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine)
    .filter((l) => l.method === "tools/call" && l.server === "bravo" && l.tool === "sleep");
  assert.deepEqual(
    lines.map((l) => l.cached === true),
    [false, true, false],
    "a hit is still audited, and marked",
  );
});

test("an uncached server's tools always reach the backend", async () => {
  const client = await open();
  const call = { name: "alpha__sleep", arguments: { ms: 200 } };
  await client.callTool(call);
  const t = Date.now();
  await client.callTool(call);
  assert.ok(Date.now() - t >= 180);
});

test("a graceful restart keeps the rate-limit buckets", async () => {
  const stingy = await open("stingy");
  await stingy.callTool({ name: "bravo__echo", arguments: { message: "1" } });
  await stingy.callTool({ name: "bravo__echo", arguments: { message: "2" } });

  await gateway.close();
  assert.ok(existsSync(join(dir, LIMITS_STATE)), "the buckets were not written");
  await start();

  const again = await open("stingy");
  await assert.rejects(
    again.callTool({ name: "bravo__echo", arguments: { message: "3" } }),
    rejectsWith("rate_limited"),
    "restarting the daemon refilled the bucket",
  );
});

test("closing a backend kills what its launcher left running", async () => {
  const launched = join(dir, "launched.yaml");
  writeFileSync(
    launched,
    `version: 1
audit:
  dir: ${JSON.stringify(join(dir, "audit-launched"))}
servers:
  wrapped:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(launcher)}]
    env:
      LAUNCHER_PID_FILE: ${JSON.stringify(pidFile)}
profiles:
  all:
    servers: ["*"]
`,
  );
  const { config } = loadConfig(launched);
  const own = assemble(config, launched);
  await own.pool.start();
  assert.equal(own.pool.backends.get("wrapped")?.state, "up");
  const straggler = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.ok(alive(straggler), "the straggler should be running while the backend is");

    await own.pool.close();
    await own.audit.close();
    const deadline = Date.now() + 5000;
    while (alive(straggler) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(straggler), false, "the launcher's child outlived the backend");
  } finally {
    // Never leave it behind, even when this test fails: a detached process can hold a CI step open.
    try {
      process.kill(straggler, "SIGKILL");
    } catch {
      // already gone, as it should be
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed process whose new parent has not reaped it yet still answers signal 0 on Linux.
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc: not Linux, and signal 0 already answered
  }
}
