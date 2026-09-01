import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const backend = (name: string) => `  ${name}:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]`;

// Each fixture exposes: ask, ask_later, crash, describe, echo, sleep, touch_note.
const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
${backend("alpha")}
${backend("bravo")}
profiles:
  default:
    servers: ["*"]

  readonly:
    servers: [alpha]
    allow:
      - "alpha__describe"
      - "alpha__echo"

  coding:
    servers: ["*"]
    deny:
      - "alpha__crash"
      - "bravo__*"
    rename:
      alpha__echo: say
      alpha__describe: about

  thrifty:
    servers: [alpha]
    limits: { rpm: 1, concurrent: 1 }
`,
);

let gateway: Gateway;
const clients: Client[] = [];

async function open(profile: string): Promise<Client> {
  const client = new Client({ name: `test-${profile}`, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`)));
  clients.push(client);
  return client;
}

const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  const pool = parts.pool;
  await pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await gateway?.close();
});

test("a curated profile lists a fraction of what the default one does", async () => {
  const all = await names(await open("default"));
  const few = await names(await open("readonly"));

  assert.equal(all.length, 14, "two fixtures, seven tools each");
  assert.deepEqual(few, ["alpha__describe", "alpha__echo"]);
});

test("a denied tool is refused when called by its exact canonical name", async () => {
  const readonly = await open("readonly");
  // Never listed for this profile, and still refused when guessed (FR-10).
  await assert.rejects(
    readonly.callTool({ name: "alpha__crash", arguments: {} }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "not_allowed",
  );
  await assert.rejects(
    readonly.callTool({ name: "bravo__echo", arguments: { message: "x" } }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "server_not_in_profile",
  );
});

test("deny beats allow through the whole stack", async () => {
  const coding = await open("coding");
  assert.deepEqual(await names(coding), [
    "about",
    "alpha__ask",
    "alpha__ask_later",
    "alpha__sleep",
    "alpha__touch_note",
    "say",
  ]);

  await assert.rejects(
    coding.callTool({ name: "alpha__crash", arguments: {} }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "denied_by_policy",
  );
});

test("a rename is a label, not a policy hole", async () => {
  const coding = await open("coding");

  // The alias works...
  assert.deepEqual(await coding.callTool({ name: "say", arguments: { message: "hi" } }), {
    content: [{ type: "text", text: "hi" }],
  });
  // ...and it is the canonical name that the deny globs see, so a rename cannot smuggle a
  // denied tool back in. `bravo__echo` renamed to `say2` would still be denied:
  await assert.rejects(
    coding.callTool({ name: "bravo__echo", arguments: { message: "hi" } }),
    (e: Error & { code?: number }) => e.code === -32004,
  );
});

test("rate limits are per profile and shared across its sessions", async () => {
  const first = await open("thrifty");
  const second = await open("thrifty");

  assert.deepEqual(await first.callTool({ name: "alpha__echo", arguments: { message: "1" } }), {
    content: [{ type: "text", text: "1" }],
  });

  // rpm: 1 — the bucket is empty now, for this profile, not merely for that session.
  await assert.rejects(
    second.callTool({ name: "alpha__echo", arguments: { message: "2" } }),
    (e: Error & { code?: number; data?: { retry_after_ms?: number } }) =>
      e.code === -32005 && typeof e.data?.retry_after_ms === "number",
  );

  // Another profile is unaffected by that exhaustion.
  const other = await open("readonly");
  assert.deepEqual(await other.callTool({ name: "alpha__echo", arguments: { message: "3" } }), {
    content: [{ type: "text", text: "3" }],
  });
});

test("an unknown tool is still a method-not-found, not a policy denial", async () => {
  const readonly = await open("readonly");
  await assert.rejects(
    readonly.callTool({ name: "alpha__nope", arguments: {} }),
    (e: Error & { code?: number }) => e.code === -32601,
  );
});
