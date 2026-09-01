import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
  fixture:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
profiles:
  default:
    servers: ["*"]
`,
);

let gateway: Gateway;
let client: Client;
let announced = 0;
let toolsBeforeBackendsWereUp = -1;

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  const pool = parts.pool;

  // Connect a client while the backends are still cold: the port must already serve (NFR-6).
  client = new Client({ name: "gateway-test", version: "0.0.0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    announced++;
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
  toolsBeforeBackendsWereUp = (await client.listTools()).tools.length;

  await pool.start();
  assert.equal(pool.backends.get("fixture")?.state, "up");
});

after(async () => {
  await client?.close();
  await gateway?.close();
});

test("serves before the backends are ready, then announces them", async () => {
  assert.equal(toolsBeforeBackendsWereUp, 0, "the listener must bind before backends connect");
  await until("the arriving backend to be announced", () => announced > 0);
});

test("lists the backend's tools, namespaced", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "fixture__ask",
      "fixture__ask_later",
      "fixture__cancellations",
      "fixture__crash",
      "fixture__describe",
      "fixture__echo",
      "fixture__emit_logs",
      "fixture__sleep",
      "fixture__touch_note",
    ],
  );
  assert.equal(tools.find((t) => t.name === "fixture__echo")?.description, "Echoes the message back.");
});

test("calls a tool through the gateway", async () => {
  const result = await client.callTool({ name: "fixture__echo", arguments: { message: "hi" } });
  assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
});

test("two sessions on one backend do not cross replies", async () => {
  const second = new Client({ name: "gateway-test-2", version: "0.0.0" });
  await second.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
  try {
    // Both clients number their requests from 1; the replies must still land correctly.
    const [a, b] = await Promise.all([
      client.callTool({ name: "fixture__echo", arguments: { message: "first" } }),
      second.callTool({ name: "fixture__echo", arguments: { message: "second" } }),
    ]);
    assert.deepEqual(a.content, [{ type: "text", text: "first" }]);
    assert.deepEqual(b.content, [{ type: "text", text: "second" }]);
  } finally {
    await second.close();
  }
});

test("an unknown tool is rejected, not forwarded", async () => {
  await assert.rejects(
    client.callTool({ name: "fixture__nope", arguments: {} }),
    (e: Error & { code?: number }) => e.code === -32601,
  );
});

test("an unknown profile is a 404", async () => {
  const res = await fetch(`${gateway.url}/mcp/ghost`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});

test("a request without a session id is refused", async () => {
  const res = await fetch(`${gateway.url}/mcp/default`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 400);
});

test("a cross-origin browser tab is refused", async () => {
  const res = await fetch(`${gateway.url}/mcp/default`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("healthz reports what `mcpgw status` needs", async () => {
  const health = (await (await fetch(`${gateway.url}/healthz`)).json()) as {
    status: string;
    sessions: number;
    pending_drift: number;
    backends: Record<string, { state: string; tools: number; restarts: number; pid: number }>;
  };
  assert.equal(health.status, "ok");
  assert.equal(health.pending_drift, 0);
  assert.ok(health.sessions >= 1);
  assert.equal(health.backends.fixture?.state, "up");
  assert.equal(health.backends.fixture?.tools, 9);
  assert.equal(health.backends.fixture?.restarts, 0);
  assert.ok(typeof health.backends.fixture?.pid === "number");
});
