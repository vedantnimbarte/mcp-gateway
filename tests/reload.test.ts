import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import type { Parts } from "../src/server.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-reload-")), "config.yaml");
const auditDir = join(dirname(configPath), "audit");

/** `marker` only ever changes bravo's argv, which is enough to change its definition. */
function writeConfig(opts: { marker: string; codingAllowsEcho: boolean; extraProfile?: boolean }) {
  writeFileSync(
    configPath,
    `version: 1
audit:
  dir: ${JSON.stringify(auditDir)}
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
  bravo:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    env:
      MARKER: ${JSON.stringify(opts.marker)}
profiles:
  all:
    servers: ["*"]
  coding:
    servers: [alpha]
    allow:
${opts.codingAllowsEcho ? '      - "alpha__echo"\n' : ""}      - "alpha__describe"
${opts.extraProfile ? "  extra:\n    servers: [alpha]\n" : ""}`,
  );
}

let gateway: Gateway;
let parts: Parts;
let client: Client;

before(async () => {
  writeConfig({ marker: "one", codingAllowsEcho: true });
  const { config } = loadConfig(configPath);
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();

  client = new Client({ name: "reload-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/coding`)));
});

after(async () => {
  await client?.close();
  await gateway?.close();
});

const reload = async () => gateway.reload(loadConfig(configPath).config);

test("a reload restarts only the server whose definition changed (NFR-8)", async () => {
  const untouched = parts.pool.backends.get("alpha")!.pid;
  const changing = parts.pool.backends.get("bravo")!.pid;

  writeConfig({ marker: "two", codingAllowsEcho: true });
  await reload();

  assert.equal(parts.pool.backends.get("alpha")!.pid, untouched, "alpha must not be restarted");
  assert.notEqual(parts.pool.backends.get("bravo")!.pid, changing, "bravo must be restarted");
  assert.equal(parts.pool.backends.get("bravo")!.state, "up");
});

test("a live session keeps working across a reload", async () => {
  assert.deepEqual(await client.callTool({ name: "alpha__echo", arguments: { message: "still" } }), {
    content: [{ type: "text", text: "still" }],
  });
});

test("a tightened policy takes effect on the existing session", async () => {
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name).sort(),
    ["alpha__describe", "alpha__echo"],
  );

  writeConfig({ marker: "two", codingAllowsEcho: false });
  await reload();

  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["alpha__describe"],
    "the removed allow entry applies without reconnecting",
  );
  await assert.rejects(
    client.callTool({ name: "alpha__echo", arguments: { message: "no" } }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "not_allowed",
  );
});

test("a profile added by a reload is reachable", async () => {
  const before = await fetch(`${gateway.url}/mcp/extra`, { method: "POST", body: "{}" });
  assert.equal(before.status, 404);

  writeConfig({ marker: "two", codingAllowsEcho: false, extraProfile: true });
  await reload();

  const extra = new Client({ name: "extra", version: "0.0.0" });
  await extra.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/extra`)));
  try {
    assert.equal((await extra.listTools()).tools.length, 9);
  } finally {
    await extra.close();
  }
});

test("shutdown drains an in-flight call instead of cutting it off", async () => {
  const { config } = loadConfig(configPath);
  const own = assemble(config, configPath);
  const draining = await startGateway(config, own, { port: 0 });
  await own.pool.start();

  const slow = new Client({ name: "slow", version: "0.0.0" });
  await slow.connect(new StreamableHTTPClientTransport(new URL(`${draining.url}/mcp/all`)));

  const call = slow.callTool({ name: "alpha__sleep", arguments: { ms: 400 } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(own.pipeline.inflight, 1, "the call should be in flight when the drain begins");

  await draining.close(5000);
  assert.deepEqual(await call, { content: [{ type: "text", text: "slept 400ms" }] });
  assert.equal(own.pipeline.inflight, 0);
  await slow.close().catch(() => {});
});
