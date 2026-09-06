// The gaps that were open between the SPEC and the code: limits, redaction and caps on the
// non-tool paths, the HTTP doors that answer before the token check, and bringing a backend
// back without restarting the daemon.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { TokenStore } from "../src/oauth.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const TOKEN = "s3cret-gateway-token";
const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-hard-"));
const configPath = join(dir, "config.yaml");

writeFileSync(
  configPath,
  `version: 1
listen:
  token: ${TOKEN}
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
guard:
  max_result_bytes: 4096
  redact:
    - 'gh[pousr]_[A-Za-z0-9]{16,}'
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    env:
      FIXTURE_PAYLOADS: "1"
profiles:
  all:
    servers: ["*"]
  stingy:
    servers: [alpha]
    limits: { rpm: 2, concurrent: 4 }
`,
);

let gateway: Gateway;
const clients: Client[] = [];

async function open(profile: string): Promise<Client> {
  const client = new Client({ name: `test-${profile}`, version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  clients.push(client);
  return client;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0, configPath });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

test("a resource payload is redacted on its way out, not only in the log", async () => {
  const client = await open("all");
  const result = await client.readResource({ uri: "mcpgw://alpha/fixture://secret" });
  const text = String((result.contents[0] as { text?: string })?.text ?? "");
  assert.ok(!text.includes("ghp_"), `secret survived: ${text}`);
  assert.match(text, /\[redacted\]/);
});

test("a resource larger than the cap is truncated, not forwarded whole", async () => {
  const client = await open("all");
  const result = await client.readResource({ uri: "mcpgw://alpha/fixture://big" });
  const text = String((result.contents[0] as { text?: string })?.text ?? "");
  assert.ok(text.length < 200_000, "the payload was forwarded uncapped");
  assert.match(text, /truncated by mcp-gateway/);
});

test("resources/read spends the profile's rate limit, like any other backend work", async () => {
  const client = await open("stingy");
  const uri = "mcpgw://alpha/fixture://note";
  await client.readResource({ uri });
  await client.readResource({ uri });
  await assert.rejects(
    () => client.readResource({ uri }),
    (e: Error & { code?: number }) => e.code === -32005,
    "a third read inside the same minute should be rate limited",
  );
});

test("healthz answers liveness without the token, and detail only with it", async () => {
  const anonymous = await (await fetch(`${gateway.url}/healthz`)).json();
  assert.deepEqual(anonymous, { status: "ok" }, "backend detail leaked to an unauthorized caller");

  const authorized = (await (await fetch(`${gateway.url}/healthz`, { headers: auth })).json()) as {
    backends: Record<string, { state: string }>;
  };
  assert.equal(authorized.backends.alpha?.state, "up");
});

test("a browser tab cannot reach the control routes", async () => {
  const origin = { Origin: "https://evil.example", ...auth };
  for (const path of ["/healthz", "/reload", `/restart/alpha`]) {
    const res = await fetch(`${gateway.url}${path}`, { method: "POST", headers: origin });
    assert.equal(res.status, 403, `${path} accepted a cross-origin request`);
  }
});

test("restart brings one backend back and leaves the rest alone", async () => {
  const before = (await (await fetch(`${gateway.url}/healthz`, { headers: auth })).json()) as {
    backends: Record<string, { pid: number }>;
  };

  const res = await fetch(`${gateway.url}/restart/alpha`, { method: "POST", headers: auth });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; tools: number };
  assert.equal(body.status, "up");
  assert.ok(body.tools > 0);

  const after = (await (await fetch(`${gateway.url}/healthz`, { headers: auth })).json()) as {
    backends: Record<string, { pid: number }>;
  };
  assert.notEqual(after.backends.alpha?.pid, before.backends.alpha?.pid, "the process was reused");
});

test("restarting a server that does not exist is a 404, not a crash", async () => {
  const res = await fetch(`${gateway.url}/restart/nope`, { method: "POST", headers: auth });
  assert.equal(res.status, 404);
});

test("the token store notices a file another process wrote", () => {
  const path = join(dir, "shared-tokens.json");
  const daemon = new TokenStore(path);
  assert.equal(daemon.get("srv").tokens, undefined);

  // What `mcpgw auth` does, from its own process.
  new TokenStore(path).set("srv", { tokens: { access_token: "fresh", token_type: "Bearer" } });

  assert.equal(daemon.get("srv").tokens?.access_token, "fresh", "the daemon held a stale store");
});
