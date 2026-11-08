// profiles.*.context: lazy tool loading, result handles and run_code keep the model's context small
// without loosening policy — every call they make is still a pipeline call.
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
import { runQuery, shapeOf } from "../src/context.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-context-"));
const configPath = join(dir, "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
servers:
  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
    env: { FIXTURE_ROWS: "1" }
profiles:
  lean:
    servers: [alpha]
    deny: ["alpha__crash"]
    context: { tools: lazy, handle_bytes: 4096, code: true, code_timeout_ms: 3000 }
  handles:
    servers: [alpha]
    context: { handle_bytes: 4096 }
  plain:
    servers: [alpha]
`,
);

// Rows 0..1999: every third is open, even ids belong to ana.
const OPEN = 667;
const OPEN_ANA = Array.from({ length: 2000 }, (_, i) => i).filter((i) => i % 3 === 0 && i % 2 === 0);

let gateway: Gateway;
let parts: Parts;
const clients: Client[] = [];

async function open(profile: string): Promise<Client> {
  const client = new Client({ name: "context-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/${profile}`)));
  clients.push(client);
  return client;
}

const body = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<CallToolResult>;

before(async () => {
  // Something the sandbox must not be able to see.
  process.env.MCPGW_CTX_SECRET = "hunter2";
  const { config } = loadConfig(configPath);
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

test("lazy lists only the gateway's own tools; plain is unchanged", async () => {
  const lean = (await (await open("lean")).listTools()).tools.map((t) => t.name);
  assert.deepEqual(lean, ["search_tools", "describe_tool", "call_tool", "query_result", "run_code"]);

  const plain = (await (await open("plain")).listTools()).tools.map((t) => t.name);
  assert.ok(plain.includes("alpha__rows"));
  assert.ok(!plain.some((n) => n === "query_result" || n === "search_tools"));

  const handles = (await (await open("handles")).listTools()).tools.map((t) => t.name);
  assert.ok(handles.includes("alpha__rows") && handles.includes("query_result"));
  assert.ok(!handles.includes("run_code"));
});

test("search and describe find allowed tools only", async () => {
  const c = await open("lean");
  assert.match(body(await call(c, "search_tools", { query: "rows table" })), /^alpha__rows — /);
  assert.match(body(await call(c, "search_tools", { query: "crash" })), /No tool matches/);

  const described = JSON.parse(body(await call(c, "describe_tool", { names: ["alpha__echo", "alpha__crash"] })));
  assert.equal(described.tools[0].name, "alpha__echo");
  assert.ok(described.tools[0].inputSchema.properties.message);
  assert.deepEqual(described.missing, ["alpha__crash"]);
});

test("call_tool passes small results through and keeps policy", async () => {
  const c = await open("lean");
  assert.equal(body(await call(c, "call_tool", { name: "alpha__echo", arguments: { message: "hi" } })), "hi");
  await assert.rejects(call(c, "call_tool", { name: "alpha__crash" }), (e: Error & { code?: number }) => e.code === -32004);
});

test("a large result comes back as a handle that query_result can slice", async () => {
  const c = await open("lean");
  const summary = body(await call(c, "call_tool", { name: "alpha__rows" }));
  assert.ok(summary.length < 4096, `summary is ${summary.length} chars`);
  assert.match(summary, /kept as handle "r1"/);
  assert.match(summary, /Shape: array\[2000\] of \{id: number, name: string, status: string, owner: \{login: string\}\}/);

  const page = JSON.parse(
    body(
      await call(c, "query_result", {
        handle: "r1",
        where: { status: "open", "owner.login": "ana" },
        fields: ["id"],
        limit: 5,
      }),
    ),
  );
  assert.equal(page.total, OPEN_ANA.length);
  assert.deepEqual(page.items, OPEN_ANA.slice(0, 5).map((id) => ({ id })));
  assert.equal(page.next_offset, 5);

  // Never more than handle_bytes, however much is asked for.
  const wide = body(await call(c, "query_result", { handle: "r1", limit: 200 }));
  assert.ok(wide.length <= 4096);
  assert.ok(JSON.parse(wide).returned < 200);

  await assert.rejects(call(c, "query_result", { handle: "r99" }), /unknown or expired handle/);
});

test("handles work on direct calls too, and are per session", async () => {
  const a = await open("handles");
  assert.match(body(await call(a, "alpha__rows")), /kept as handle "r1"/);
  const b = await open("handles");
  await assert.rejects(call(b, "query_result", { handle: "r1" }), /unknown or expired handle/);
});

test("run_code chains calls and returns only its output", async () => {
  const c = await open("lean");
  const result = await call(c, "run_code", {
    code: `const rows = await tools.call("alpha__rows");
           console.log("rows:", rows.length);
           return rows.filter((r) => r.status === "open").length;`,
  });
  assert.equal(body(result), `rows: 2000\n\nreturned: ${OPEN}`);
  assert.ok(!result.isError);

  const found = await call(c, "run_code", { code: `return (await tools.search("echo")).map((t) => t.name)` });
  assert.equal(body(found), '["alpha__echo"]');
});

test("run_code is held to the profile's policy", async () => {
  const c = await open("lean");
  const result = await call(c, "run_code", { code: `await tools.call("alpha__crash")` });
  assert.ok(result.isError);
  assert.match(body(result), /not available: denied_by_policy/);
});

test("the sandbox has no file system, no processes and no environment", async () => {
  const c = await open("lean");
  const probe = await call(c, "run_code", {
    code: `const fs = await import("node:fs");
           const cp = await import("node:child_process");
           const tryIt = (f) => { try { f(); return "allowed"; } catch (e) { return e.code; } };
           return {
             read: tryIt(() => fs.readFileSync(${JSON.stringify(configPath)})),
             spawn: tryIt(() => cp.spawnSync(process.execPath, ["-v"])),
             secret: process.env.MCPGW_CTX_SECRET ?? null,
           };`,
  });
  assert.deepEqual(JSON.parse(body(probe)), { read: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", secret: null });
});

test("run_code is killed at its timeout and errors are reported", async () => {
  const c = await open("lean");
  const started = Date.now();
  const spin = await call(c, "run_code", { code: "while (true) {}" });
  assert.ok(spin.isError);
  assert.match(body(spin), /timed out after 3000 ms/);
  assert.ok(Date.now() - started < 8000);

  const thrown = await call(c, "run_code", { code: `console.log("before"); throw new TypeError("nope")` });
  assert.ok(thrown.isError);
  assert.equal(body(thrown), "before\nTypeError: nope");
});

test("run_code and the calls it makes are audited", async () => {
  await parts.audit.flush();
  const lines = readdirSync(join(dir, "audit"))
    .flatMap((f) => readFileSync(join(dir, "audit", f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditLine);
  assert.ok(lines.some((l) => l.method === "run_code" && l.status === "ok" && l.args_hash));
  assert.ok(lines.some((l) => l.method === "run_code" && l.status === "timeout"));
  assert.ok(lines.some((l) => l.method === "tools/call" && l.tool === "crash" && l.decision === "denied_by_policy"));
});

test("an alias may not take a gateway tool's name", () => {
  assert.throws(
    () =>
      parseConfig(
        `version: 1
servers: { a: { transport: stdio, command: x } }
profiles: { p: { servers: [a], rename: { a__echo: run_code } } }
`,
        "inline",
      ),
    (e: Error) => e instanceof ConfigError && /reserved for the gateway's own tools/.test(e.message),
  );
});

test("query and shape on text and objects", () => {
  assert.equal(shapeOf("a\nb\nc"), "text, 3 lines");
  const lines = runQuery("alpha\nbeta\ngamma", { contains: "TA" }, 1000) as { items: string[] };
  assert.deepEqual(lines.items, ["beta"]);
  assert.deepEqual(runQuery({ a: { b: [1, 2, 3] } }, { path: "a.b.1" }, 1000), 2);
  assert.throws(() => runQuery({ a: 1 }, { path: "nope" }, 1000), /nothing at path/);
});
