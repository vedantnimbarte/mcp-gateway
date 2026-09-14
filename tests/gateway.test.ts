import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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

/** `fetch` will not send a Host header of our choosing, so this goes through node:http. */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

test("a DNS-rebound page is refused by its Host header, even without an Origin", async () => {
  // Browsers omit Origin on a same-origin GET, and a rebound page is same-origin with itself.
  assert.equal(await statusWithHost(`${gateway.url}/healthz`, "evil.example:8420"), 403);
  const port = new URL(gateway.url).port;
  assert.equal(await statusWithHost(`${gateway.url}/healthz`, `localhost:${port}`), 200);
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

test("the idle sweep closes a silent session but spares one that is still streaming", async () => {
  // A client that initialized over raw HTTP and then went quiet: nothing of it is open any more.
  const res = await fetch(`${gateway.url}/mcp/default`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gone", version: "0" },
      },
    }),
  });
  const silent = res.headers.get("mcp-session-id")!;
  await res.text();
  await until("the silent session to settle", () => gateway.sessions.get(silent)?.open === 0);

  // `client` holds its GET stream open. Both look an hour stale to the sweep.
  gateway.sessions.sweep(Date.now() + 60 * 60 * 1000);
  await until("the silent session to be swept", () => gateway.sessions.get(silent) === undefined);
  assert.equal((await client.listTools()).tools.length > 0, true, "the streaming client was swept");
});
