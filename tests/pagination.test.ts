import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";
import { page } from "../src/session.js";

const letters = ["a", "b", "c", "d", "e"];
const key = (s: string) => s;
const invalid = (e: Error & { code?: number }) => e.code === -32602;

test("without a page size, a listing is one page and has no cursor to follow", () => {
  assert.deepEqual(page(letters, key, undefined, undefined), { items: letters });
  assert.throws(() => page(letters, key, undefined, "anything"), invalid);
});

test("pages cover the listing exactly once, in order", () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const next = page(letters, key, 2, cursor);
    seen.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, letters);
});

test("a cursor from a listing that has since changed is refused, not reinterpreted", () => {
  const { nextCursor } = page(letters, key, 2, undefined);
  assert.throws(() => page(["a", "b", "x", "d", "e"], key, 2, nextCursor), invalid);
  assert.throws(() => page(letters, key, 2, "not-a-cursor"), invalid);
});

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpgw-pages-"));
const configPath = join(dir, "config.yaml");
let gateway: Gateway;
let client: Client;

before(async () => {
  writeFileSync(
    configPath,
    `version: 1
listen:
  page_size: 4
audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
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
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
  client = new Client({ name: "pages", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
});

after(async () => {
  await client?.close();
  await gateway?.close();
});

test("a client following nextCursor sees every tool once", async () => {
  const first = await client.listTools();
  assert.equal(first.tools.length, 4);
  assert.ok(first.nextCursor, "more than one page of fixture tools");

  const names = first.tools.map((t) => t.name);
  let cursor: string | undefined = first.nextCursor;
  while (cursor) {
    const next = await client.listTools({ cursor });
    names.push(...next.tools.map((t) => t.name));
    cursor = next.nextCursor;
  }
  assert.equal(new Set(names).size, names.length, "no tool repeated");
  assert.ok(names.includes("alpha__echo") && names.includes("alpha__touch_note"));
});
