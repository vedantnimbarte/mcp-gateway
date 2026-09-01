import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { namespaceUri, parseUri } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const backend = (name: string) => `  ${name}:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]`;

const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-res-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
${backend("alpha")}
${backend("bravo")}
profiles:
  all:
    servers: ["*"]
  onlyAlpha:
    servers: [alpha]
  noPrompts:
    servers: [alpha]
    deny: ["alpha__review"]
`,
);

let gateway: Gateway;
const clients: Client[] = [];
const updates: string[] = [];

async function open(profile: string): Promise<Client> {
  const client = new Client({ name: `test-${profile}`, version: "0.0.0" });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(`${profile}:${n.params.uri}`);
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`)));
  clients.push(client);
  return client;
}

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

test("resource URIs round-trip through the gateway scheme", () => {
  // The original URI keeps its own scheme, so nesting has to survive intact.
  for (const original of ["fixture://note", "file:///c:/x y.txt", "https://a/b?c=d#e"]) {
    const namespaced = namespaceUri("alpha", original);
    assert.deepEqual(parseUri(namespaced), { server: "alpha", original });
  }
  assert.equal(parseUri("fixture://note"), undefined, "an un-namespaced URI is not ours");
  assert.equal(parseUri("mcpgw://noslash"), undefined);
});

test("resources from every backend are merged and namespaced", async () => {
  const all = await open("all");
  const { resources } = await all.listResources();

  assert.deepEqual(
    resources.map((r) => r.uri).sort(),
    ["mcpgw://alpha/fixture://note", "mcpgw://bravo/fixture://note"],
  );

  const { resourceTemplates } = await all.listResourceTemplates();
  assert.deepEqual(
    resourceTemplates.map((t) => t.uriTemplate).sort(),
    ["mcpgw://alpha/fixture://page/{id}", "mcpgw://bravo/fixture://page/{id}"],
  );
});

test("a resource is read from the backend that owns it", async () => {
  const all = await open("all");
  const text = (r: { contents: unknown[] }) => (r.contents[0] as { text?: string }).text;

  assert.equal(text(await all.readResource({ uri: "mcpgw://alpha/fixture://note" })), "the note says hello");
  // Templated URIs work the same way: the gateway only de-namespaces.
  assert.equal(text(await all.readResource({ uri: "mcpgw://bravo/fixture://page/7" })), "page 7");
});

test("a profile cannot read a resource from a server it does not have", async () => {
  const narrow = await open("onlyAlpha");
  assert.deepEqual(
    (await narrow.listResources()).resources.map((r) => r.uri),
    ["mcpgw://alpha/fixture://note"],
  );

  await assert.rejects(
    narrow.readResource({ uri: "mcpgw://bravo/fixture://note" }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "server_not_in_profile",
  );
});

test("a URI that is not ours is refused rather than forwarded", async () => {
  const all = await open("all");
  await assert.rejects(
    all.readResource({ uri: "file:///etc/passwd" }),
    (e: Error & { code?: number }) => e.code === -32602,
  );
});

test("prompts are namespaced, listed and fetched", async () => {
  const all = await open("all");
  assert.deepEqual(
    (await all.listPrompts()).prompts.map((p) => p.name).sort(),
    ["alpha__review", "bravo__review"],
  );

  const prompt = await all.getPrompt({ name: "alpha__review", arguments: { subject: "the diff" } });
  assert.equal(prompt.messages[0]?.content.type, "text");
  assert.match(String((prompt.messages[0]?.content as { text: string }).text), /review the diff/);
});

test("prompts obey the same allow/deny rules as tools", async () => {
  const denied = await open("noPrompts");
  assert.deepEqual((await denied.listPrompts()).prompts, []);

  // And it is still refused when guessed by name (FR-10).
  await assert.rejects(
    denied.getPrompt({ name: "alpha__review", arguments: { subject: "x" } }),
    (e: Error & { code?: number; data?: { reason?: string } }) =>
      e.code === -32004 && e.data?.reason === "denied_by_policy",
  );
});

test("an unknown prompt is a method-not-found", async () => {
  const all = await open("all");
  await assert.rejects(
    all.getPrompt({ name: "alpha__nope", arguments: {} }),
    (e: Error & { code?: number }) => e.code === -32601,
  );
});

test("a resource update reaches only the sessions that subscribed", async () => {
  const watching = await open("all");
  const notWatching = await open("onlyAlpha");
  await notWatching.listResources(); // connected, but never subscribes

  await watching.subscribeResource({ uri: "mcpgw://alpha/fixture://note" });
  updates.length = 0;

  await watching.callTool({ name: "alpha__touch_note", arguments: {} });
  await until("the update to arrive", () => updates.length > 0);

  assert.deepEqual(updates, ["all:mcpgw://alpha/fixture://note"]);
});

test("unsubscribing stops the notifications", async () => {
  const watching = await open("all");
  await watching.subscribeResource({ uri: "mcpgw://bravo/fixture://note" });
  await watching.unsubscribeResource({ uri: "mcpgw://bravo/fixture://note" });
  updates.length = 0;

  await watching.callTool({ name: "bravo__touch_note", arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(updates, []);
});

test("the listing capabilities are advertised to the client", async () => {
  const all = await open("all");
  const capabilities = all.getServerCapabilities();
  assert.ok(capabilities?.resources, "resources must be advertised");
  assert.equal(capabilities?.resources?.subscribe, true);
  assert.ok(capabilities?.prompts, "prompts must be advertised");
  assert.ok(capabilities?.completions, "completions must be advertised");
});

test("resource and prompt listings are announced when a backend arrives", async () => {
  // A second gateway, so the client is connected before its backends are.
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  const late = await startGateway(config, parts, { port: 0 });
  const seen: string[] = [];

  const client = new Client({ name: "late", version: "0.0.0" });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    seen.push("resources");
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    seen.push("prompts");
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${late.url}/mcp/all`)));

  assert.deepEqual((await client.listResources()).resources, [], "nothing is up yet");
  await parts.pool.start();

  await until("both listings to be announced", () => seen.includes("resources") && seen.includes("prompts"));
  assert.equal((await client.listResources()).resources.length, 2);

  await client.close();
  await late.close();
});
