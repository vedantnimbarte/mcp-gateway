import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-cancel-")), "config.yaml");
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
profiles:
  default:
    servers: ["*"]
`,
);

let gateway: Gateway;
const clients: Client[] = [];
const logs: { level: string; data: unknown }[] = [];

async function open(): Promise<Client> {
  const client = new Client({ name: "cancel-test", version: "0.0.0" });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push({ level: n.params.level, data: n.params.data });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
  clients.push(client);
  return client;
}

const cancellations = async (client: Client): Promise<number> => {
  const result = await client.callTool({ name: "alpha__cancellations", arguments: {} });
  return Number((result.content as { text: string }[])[0]?.text);
};

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await gateway?.close();
});

test("cancelling a call reaches the backend, not just the gateway", async () => {
  const client = await open();
  const before = await cancellations(client);

  const controller = new AbortController();
  const call = client.callTool(
    { name: "alpha__sleep", arguments: { ms: 4000 } },
    undefined,
    { signal: controller.signal },
  );

  // Let it get all the way down to the backend before pulling the plug.
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  await assert.rejects(call);

  // The backend's own handler saw the abort — the cancellation was forwarded, not swallowed.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await cancellations(client), before + 1);
});

test("one client's cancellation does not disturb another's call", async () => {
  const first = await open();
  const second = await open();
  const before = await cancellations(first);

  const controller = new AbortController();
  const doomed = first.callTool(
    { name: "alpha__sleep", arguments: { ms: 4000 } },
    undefined,
    { signal: controller.signal },
  );
  const survivor = second.callTool({ name: "alpha__sleep", arguments: { ms: 600 } });

  await new Promise((r) => setTimeout(r, 200));
  controller.abort();

  await assert.rejects(doomed);
  assert.deepEqual(await survivor, { content: [{ type: "text", text: "slept 600ms" }] });
  assert.equal(await cancellations(first), before + 1, "exactly one call was cancelled");
});

test("backend log messages reach the session that triggered them", async () => {
  const client = await open();
  logs.length = 0;

  await client.callTool({ name: "alpha__emit_logs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));

  // Default level is info, so debug is dropped and the rest arrive.
  assert.deepEqual(
    logs.map((l) => l.level),
    ["info", "warning", "error"],
  );
  assert.equal(logs[0]?.data, "info from the fixture");
});

test("logging/setLevel filters what that session receives", async () => {
  const client = await open();
  await client.setLoggingLevel("error");
  logs.length = 0;

  await client.callTool({ name: "alpha__emit_logs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(logs.map((l) => l.level), ["error"]);

  // Turning it down again lets everything through, debug included.
  await client.setLoggingLevel("debug");
  logs.length = 0;
  await client.callTool({ name: "alpha__emit_logs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(logs.map((l) => l.level), ["debug", "info", "warning", "error"]);
});

test("a level is per session, and is never pushed down to the backend", async () => {
  const quiet = await open();
  const loud = await open();
  await quiet.setLoggingLevel("emergency");
  await loud.setLoggingLevel("debug");
  logs.length = 0;

  // The backend is shared: if the gateway had forwarded either level, the other would suffer.
  await quiet.callTool({ name: "alpha__emit_logs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(logs.length, 0, "the quiet session asked for nothing below emergency");

  await loud.callTool({ name: "alpha__emit_logs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(logs.map((l) => l.level), ["debug", "info", "warning", "error"]);
});

test("the gateway advertises that it can be configured for logging", async () => {
  const client = await open();
  assert.ok(client.getServerCapabilities()?.logging, "logging must be advertised");
});
