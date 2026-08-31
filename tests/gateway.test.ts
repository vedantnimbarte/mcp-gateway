import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBackends, startBackends } from "../src/backend.js";
import { loadConfig } from "../src/config.js";
import { startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));

const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
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

before(async () => {
  const { config } = loadConfig(configPath);
  const backends = createBackends(config);
  gateway = await startGateway(config, backends, { port: 0 });
  await startBackends(backends.values(), (name, e) => assert.fail(`${name}: ${e.message}`));

  client = new Client({ name: "gateway-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
});

after(async () => {
  await client?.close();
  await gateway?.close();
});

test("lists the backend's tools, namespaced", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["fixture__describe", "fixture__echo"],
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

test("healthz reports backend state", async () => {
  const health = (await (await fetch(`${gateway.url}/healthz`)).json()) as {
    backends: Record<string, string>;
  };
  assert.deepEqual(health.backends, { fixture: "up" });
});
