// Per-client keys (listen.clients), argument rules (profiles.*.arguments), and approving a held
// call from the status page.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLine } from "../src/audit.js";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { checkArguments, normalizePath } from "../src/policy.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const ADMIN = "admin-token-0123456789";
const AGENT = "agent-token-0123456789";
const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-access-"));
const configPath = join(dir, "config.yaml");
writeFileSync(
  configPath,
  `version: 1
listen:
  token: ${ADMIN}
  clients:
    - { name: agent, token: ${AGENT}, profiles: [reader] }
audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
guard:
  approval_timeout_ms: 4000
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
profiles:
  reader:
    servers: [alpha]
    arguments:
      - { tools: ["alpha__echo"], name: message, deny: ["*secret*"] }
  writer:
    servers: [alpha]
    approve: ["alpha__describe"]
    arguments:
      - { tools: ["alpha__echo"], name: message, allow: ["/code/*"], as: path }
`,
);

let gateway: Gateway;
let parts: Parts;
const clients: Client[] = [];

async function open(profile: string, token?: string): Promise<Client> {
  const client = new Client({ name: "access-test", version: "0.0.0" });
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`), { requestInit: { headers } }),
  );
  clients.push(client);
  return client;
}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const refused = (reason: string) => (e: Error & { code?: number; data?: { reason?: string } }) =>
  e.code === -32004 && e.data?.reason === reason;

async function lines(): Promise<AuditLine[]> {
  await parts.audit.flush();
  return readdirSync(join(dir, "audit"))
    .flatMap((f) => readFileSync(join(dir, "audit", f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditLine);
}

before(async () => {
  const { config } = loadConfig(configPath);
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0, configPath });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

test("a client key opens its own profiles and no others", async () => {
  const agent = await open("reader", AGENT);
  assert.equal(text(await agent.callTool({ name: "alpha__echo", arguments: { message: "hi" } })), "hi");

  await assert.rejects(open("writer", AGENT), /403|may not use profile/);
  await assert.rejects(open("reader"), /401|unauthorized/);
  // The gateway token still reaches everything.
  await open("writer", ADMIN);

  // Not the status page's detail, nor its controls.
  const detail = await fetch(`${gateway.url}/audit/recent`, { headers: { authorization: `Bearer ${AGENT}` } });
  assert.equal(detail.status, 401);

  const calls = (await lines()).filter((l) => l.method === "tools/call" && l.client_key === "agent");
  assert.ok(calls.length >= 1, "the agent's calls carry its key");
});

test("a session cannot be carried on with a different key", async () => {
  const init = await fetch(`${gateway.url}/mcp/reader`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  });
  const session = init.headers.get("mcp-session-id")!;
  await init.text();
  assert.ok(session);
  const hijack = await fetch(`${gateway.url}/mcp/reader`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AGENT}`,
      "mcp-session-id": session,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(hijack.status, 404);
});

test("argument rules refuse what the profile does not allow", async () => {
  const reader = await open("reader", AGENT);
  await assert.rejects(
    reader.callTool({ name: "alpha__echo", arguments: { message: "the secret plan" } }),
    refused("argument_denied"),
  );

  const writer = await open("writer", ADMIN);
  assert.equal(text(await writer.callTool({ name: "alpha__echo", arguments: { message: "/code/a.txt" } })), "/code/a.txt");
  await assert.rejects(
    writer.callTool({ name: "alpha__echo", arguments: { message: "/code/../etc/passwd" } }),
    refused("argument_denied"),
  );
  assert.ok((await lines()).some((l) => l.decision === "argument_denied"));
});

async function waiting(): Promise<{ id: string; canonical: string }[]> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${gateway.url}/approvals`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const body = (await r.json()) as { approvals: { id: string; canonical: string }[] };
    if (body.approvals.length) return body.approvals;
    await new Promise((res) => setTimeout(res, 50));
  }
  return [];
}

test("a client that cannot ask still gets its approval from the status page", async () => {
  const writer = await open("writer", ADMIN);
  const call = writer.callTool({ name: "alpha__describe", arguments: {} });
  const [held] = await waiting();
  assert.equal(held?.canonical, "alpha__describe");

  // Answering is the gateway token's alone.
  const asAgent = await fetch(`${gateway.url}/approvals/${held!.id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT}` },
  });
  assert.equal(asAgent.status, 401);

  const ok = await fetch(`${gateway.url}/approvals/${held!.id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(ok.status, 200);
  assert.match(text(await call), /fixture server/);
  assert.ok((await lines()).some((l) => l.tool === "describe" && l.approved === true && l.approved_via === "status_page"));
});

test("a denial on the status page refuses the call", async () => {
  const writer = await open("writer", ADMIN);
  const call = writer.callTool({ name: "alpha__describe", arguments: {} });
  const [held] = await waiting();
  await fetch(`${gateway.url}/approvals/${held!.id}/deny`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  await assert.rejects(call, refused("approval_denied"));
  const gone = await fetch(`${gateway.url}/approvals/${held!.id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(gone.status, 404, "an answered call is no longer waiting");
});

test("argument checks and path normalising, on their own", () => {
  assert.equal(normalizePath("C:\\code\\..\\Windows"), "C:/Windows");
  assert.equal(normalizePath("/code/./a/../b"), "/code/b");
  const profile = {
    arguments: [{ tools: ["fs__*"], name: "paths", allow: ["/code/*"], deny: [], as: "path" as const }],
  } as unknown as Parameters<typeof checkArguments>[0];
  assert.equal(checkArguments(profile, "fs__read", { paths: ["/code/a", "/code/b"] }), undefined);
  assert.match(checkArguments(profile, "fs__read", { paths: ["/code/a", "/etc/x"] })!, /matches none of allow/);
  assert.equal(checkArguments(profile, "gh__read", { paths: ["/etc/x"] }), undefined, "only matching tools");
  assert.equal(checkArguments(profile, "fs__read", {}), undefined, "an absent argument is the schema's business");
});

test("client keys and argument rules are validated", () => {
  const bad = (yaml: string, pattern: RegExp) =>
    assert.throws(() => parseConfig(yaml, "inline"), (e: Error) => e instanceof ConfigError && pattern.test(e.message));
  const base = "version: 1\nservers: { a: { transport: stdio, command: x } }\n";
  bad(`${base}listen: { clients: [{ name: k, token: aaaaaaaaaaaaaaaa, profiles: [nope] }] }\nprofiles: { p: {} }\n`, /unknown profile "nope"/);
  bad(
    `${base}listen: { token: aaaaaaaaaaaaaaaa, clients: [{ name: k, token: aaaaaaaaaaaaaaaa, profiles: [p] }] }\nprofiles: { p: {} }\n`,
    /already used/,
  );
  bad(`${base}profiles: { p: { arguments: [{ tools: ["a__*"], name: x }] } }\n`, /needs an allow or a deny list/);
});
