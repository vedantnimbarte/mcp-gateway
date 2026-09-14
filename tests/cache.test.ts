import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ResponseCache } from "../src/cache.js";
import type { Config } from "../src/config.js";

const tool: Tool = { name: "read", inputSchema: { type: "object" } };
const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function cacheWith(cache: { tools: string[]; ttl_ms: number; max_entries: number }) {
  let t = 0;
  const config = { servers: { fs: { cache }, other: {} } } as unknown as Config;
  return { cache: new ResponseCache(config, () => t), advance: (ms: number) => (t += ms) };
}

test("only the tools a server names are cached", () => {
  const { cache } = cacheWith({ tools: ["read*"], ttl_ms: 1000, max_entries: 10 });
  assert.ok(cache.keyFor("fs", "read_file", tool, {}));
  assert.equal(cache.keyFor("fs", "write_file", tool, {}), undefined);
  assert.equal(cache.keyFor("other", "read_file", tool, {}), undefined);
});

test("a hit lasts ttl_ms and no longer", () => {
  const { cache, advance } = cacheWith({ tools: ["*"], ttl_ms: 1000, max_entries: 10 });
  const key = cache.keyFor("fs", "read", tool, { path: "a" })!;
  cache.set(key, "fs", ok("a"));
  advance(999);
  assert.deepEqual(cache.get(key), ok("a"));
  advance(1);
  assert.equal(cache.get(key), undefined);
});

test("argument order does not matter, a changed tool definition does", () => {
  const { cache } = cacheWith({ tools: ["*"], ttl_ms: 1000, max_entries: 10 });
  assert.equal(
    cache.keyFor("fs", "read", tool, { a: 1, b: 2 }),
    cache.keyFor("fs", "read", tool, { b: 2, a: 1 }),
  );
  const drifted = { ...tool, description: "now does something else" };
  assert.notEqual(cache.keyFor("fs", "read", tool, {}), cache.keyFor("fs", "read", drifted, {}));
});

test("errors are never cached", () => {
  const { cache } = cacheWith({ tools: ["*"], ttl_ms: 1000, max_entries: 10 });
  const key = cache.keyFor("fs", "read", tool, {})!;
  cache.set(key, "fs", { ...ok("boom"), isError: true });
  assert.equal(cache.get(key), undefined);
});

test("a server keeps at most max_entries, dropping the oldest", () => {
  const { cache } = cacheWith({ tools: ["*"], ttl_ms: 1000, max_entries: 2 });
  const keys = ["a", "b", "c"].map((p) => cache.keyFor("fs", "read", tool, { p })!);
  keys.forEach((k, i) => cache.set(k, "fs", ok(String(i))));
  assert.equal(cache.get(keys[0]!), undefined);
  assert.deepEqual(cache.get(keys[2]!), ok("2"));
});
