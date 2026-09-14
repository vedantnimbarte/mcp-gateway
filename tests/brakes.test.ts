// Phase 9: a call on an approve list runs only when a human says yes in the calling client.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLine } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-brakes-"));
const configPath = join(dir, "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
guard:
  approval_timeout_ms: 2000
  redact:
    - 'gh[pousr]_[A-Za-z0-9]{16,}'
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
profiles:
  careful:
    servers: [alpha]
    approve: ["alpha__echo"]
    rename:
      alpha__echo: say
`,
);

let gateway: Gateway;
let parts: Parts;
const clients: Client[] = [];
/** What the human does with the next approval prompt, and what they were shown. */
let answer: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult> = () => ({ action: "decline" });
const asked: ElicitRequest[] = [];

async function open(canElicit: boolean): Promise<Client> {
  const client = new Client(
    { name: canElicit ? "eliciting" : "plain", version: "0.0.0" },
    { capabilities: canElicit ? { elicitation: {} } : {} },
  );
  if (canElicit) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request);
      return answer(request);
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/careful`)));
  clients.push(client);
  return client;
}

before(async () => {
  const { config } = loadConfig(configPath);
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

async function toolCalls(): Promise<AuditLine[]> {
  await parts.audit.flush();
  return readdirSync(join(dir, "audit"))
    .flatMap((f) => readFileSync(join(dir, "audit", f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditLine)
    .filter((l) => l.method === "tools/call");
}

const refusedFor = (reason: string) => (e: Error & { code?: number; data?: { reason?: string } }) =>
  e.code === -32004 && e.data?.reason === reason;

test("an approved call runs, and its audit line says a human approved it", async () => {
  const client = await open(true);
  answer = () => ({ action: "accept", content: { approve: true } });
  asked.length = 0;

  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUV";
  const result = await client.callTool({ name: "say", arguments: { message: `ok ${secret}` } });
  assert.deepEqual(result.content, [{ type: "text", text: "ok [redacted]" }]);

  assert.equal(asked.length, 1);
  const prompt = asked[0]!.params as { message: string };
  assert.match(prompt.message, /Allow say \(alpha__echo\)\?/);
  assert.match(prompt.message, /approve: alpha__echo/);
  assert.doesNotMatch(prompt.message, /ghp_/, "the prompt shows redacted arguments");

  assert.equal((await toolCalls()).at(-1)?.approved, true);
});

test("a declined, dismissed or unanswered prompt refuses the call", async () => {
  const client = await open(true);
  for (const reply of [
    () => ({ action: "decline" as const }),
    () => ({ action: "cancel" as const }),
    () => ({ action: "accept" as const, content: { approve: false } }),
    () => new Promise<ElicitResult>(() => {}), // the human walked away; approval_timeout_ms is 2 s
  ]) {
    answer = reply;
    await assert.rejects(
      client.callTool({ name: "say", arguments: { message: "no" } }),
      refusedFor("approval_denied"),
    );
  }
  assert.equal((await toolCalls()).at(-1)?.decision, "approval_denied");
});

test("a client that cannot be asked is refused, not waved through", async () => {
  const client = await open(false);
  await assert.rejects(
    client.callTool({ name: "say", arguments: { message: "sneaky" } }),
    refusedFor("approval_unavailable"),
  );
});

test("the canonical name needs approval too: renaming is not a way around it", async () => {
  const client = await open(true);
  answer = () => ({ action: "decline" });
  asked.length = 0;
  // The profile renamed it, so its canonical name is not listed — but a guess still resolves.
  await assert.rejects(
    client.callTool({ name: "alpha__echo", arguments: { message: "guessed" } }),
    refusedFor("approval_denied"),
  );
  assert.equal(asked.length, 1);
});

test("tools not on the approve list are never held up", async () => {
  const client = await open(false);
  asked.length = 0;
  await client.callTool({ name: "alpha__describe", arguments: {} });
  assert.equal(asked.length, 0);
});
