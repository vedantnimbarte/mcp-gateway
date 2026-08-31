import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import type { Pool } from "../src/pool.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const SERVERS = ["alpha", "bravo", "charlie", "delta"];

const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
${SERVERS.map(
  (name) => `  ${name}:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    restart: { max_retries: 5, backoff_ms: 100 }`,
).join("\n")}
profiles:
  all:
    servers: ["*"]
  onlyAlpha:
    servers: [alpha]
`,
);

let gateway: Gateway;
let pool: Pool;
/** Sees every backend. */
let wide: Client;
/** Sees only `alpha`, so nothing that happens to `charlie` concerns it. */
let narrow: Client;
const wideNotifications: string[] = [];
const narrowNotifications: string[] = [];
const events: { event: string; fields: Record<string, unknown> }[] = [];

const alive = (pid: number | null) => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connect(profile: string, sink: string[]): Promise<Client> {
  const client = new Client(
    { name: `test-${profile}`, version: "0.0.0" },
    { capabilities: { sampling: {} } },
  );
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    sink.push(profile);
  });
  client.setRequestHandler(CreateMessageRequestSchema, () => ({
    role: "assistant",
    content: { type: "text", text: `pong from ${profile}` },
    model: "test",
  }));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`)));
  return client;
}

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath, (event, fields) => events.push({ event, fields }));
  pool = parts.pool;
  gateway = await startGateway(config, parts, { port: 0 });
  await pool.start();
  wide = await connect("all", wideNotifications);
  narrow = await connect("onlyAlpha", narrowNotifications);
});

after(async () => {
  await wide?.close();
  await narrow?.close();
  await gateway?.close();
});

test("one process per configured backend, however many clients are connected", () => {
  const pids = SERVERS.map((name) => pool.backends.get(name)!.pid);
  assert.equal(new Set(pids).size, 4);
  assert.ok(pids.every(alive), `expected 4 live children, got ${pids.join(", ")}`);
});

test("a profile sees only its own servers", async () => {
  const { tools } = await narrow.listTools();
  assert.deepEqual([...new Set(tools.map((t) => t.name.split("__")[0]))], ["alpha"]);
  assert.equal((await wide.listTools()).tools.length, SERVERS.length * 5);
});

test("a crashed backend fails its call, vanishes, and comes back", async () => {
  const charlie = pool.backends.get("charlie")!;
  const doomed = charlie.pid;
  wideNotifications.length = 0;
  narrowNotifications.length = 0;

  await assert.rejects(
    wide.callTool({ name: "charlie__crash", arguments: {} }),
    (e: Error & { code?: number }) => e.code === -32003,
    "the in-flight call must fail with backend-unavailable, not hang",
  );

  await until("charlie to be seen as down", () => charlie.state === "down");
  await until("the wide session to be told", () => wideNotifications.length > 0);

  const during = await wide.listTools();
  assert.equal(
    during.tools.some((t) => t.name.startsWith("charlie__")),
    false,
    "a down backend's tools must disappear from listings",
  );
  // The other three are untouched, and the narrow session never noticed anything.
  assert.deepEqual(
    await wide.callTool({ name: "alpha__echo", arguments: { message: "still here" } }),
    { content: [{ type: "text", text: "still here" }] },
  );
  assert.deepEqual(narrowNotifications, [], "a session that cannot see charlie must not be woken");

  await until("charlie to restart", () => charlie.state === "up", 20_000);
  await until("the wide session to be told again", () => wideNotifications.length > 1);

  const after = await wide.listTools();
  assert.equal(after.tools.filter((t) => t.name.startsWith("charlie__")).length, 5);
  assert.equal(alive(doomed), false, "the crashed child must not linger");
  assert.notEqual(charlie.pid, doomed);
  assert.equal(charlie.restarts, 1);

  const pids = SERVERS.map((name) => pool.backends.get(name)!.pid);
  assert.equal(new Set(pids).size, 4);
  assert.ok(pids.every(alive), "still exactly four backend processes");
});

test("the recovered backend is callable again", async () => {
  assert.deepEqual(
    await wide.callTool({ name: "charlie__echo", arguments: { message: "back" } }),
    { content: [{ type: "text", text: "back" }] },
  );
});

test("a reverse request reaches the session that triggered it", async () => {
  assert.deepEqual(await wide.callTool({ name: "alpha__ask", arguments: {} }), {
    content: [{ type: "text", text: "pong from all" }],
  });
  assert.deepEqual(await narrow.callTool({ name: "alpha__ask", arguments: {} }), {
    content: [{ type: "text", text: "pong from onlyAlpha" }],
  });
});

test("a reverse request with nothing in flight is refused, not guessed", async () => {
  events.length = 0;
  await wide.callTool({ name: "bravo__ask_later", arguments: {} });
  await until("the unroutable request to be logged", () =>
    events.some((e) => e.event === "unroutable"),
  );
  assert.equal(events.find((e) => e.event === "unroutable")?.fields.server, "bravo");
});
