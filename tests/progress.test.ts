// Phase 7: long-running calls. Progress reaches the client that asked for it and no other, keeps
// a call alive past call_timeout_ms up to max_call_ms, and a dropped SSE stream resumes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";
import { RecentEvents } from "../src/session.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-progress-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
defaults:
  call_timeout_ms: 400
  max_call_ms: 1500
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

async function open(): Promise<Client> {
  const client = new Client({ name: "progress-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp/default`)));
  clients.push(client);
  return client;
}

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await gateway?.close();
});

test("progress reaches the client that asked for it, and never the other one", async () => {
  const [a, b] = [await open(), await open()];
  const seen: Record<string, Progress[]> = { a: [], b: [] };
  // Both clients number their requests alike, so their progress tokens collide on purpose.
  await Promise.all(
    (["a", "b"] as const).map((tag, i) =>
      [a, b][i]!.callTool(
        { name: "alpha__sleep", arguments: { ms: 700, progress_ms: 100, tag } },
        undefined,
        { onprogress: (p) => seen[tag]!.push(p) },
      ),
    ),
  );
  for (const tag of ["a", "b"]) {
    assert.ok(seen[tag]!.length >= 3, `${tag} saw ${seen[tag]!.length} progress notes`);
    assert.deepEqual(new Set(seen[tag]!.map((p) => p.message)), new Set([tag]), "cross-talk");
  }
});

test("progress keeps a call alive past call_timeout_ms; a silent call still times out", async () => {
  const client = await open();
  // No onprogress here: the gateway asks the backend for progress regardless, to keep it alive.
  assert.deepEqual(
    await client.callTool({ name: "alpha__sleep", arguments: { ms: 1000, progress_ms: 100 } }),
    { content: [{ type: "text", text: "slept 1000ms" }] },
  );
  await assert.rejects(
    client.callTool({ name: "alpha__sleep", arguments: { ms: 1000 } }),
    (e: Error & { code?: number }) => e.code === -32002,
  );
});

test("progress cannot keep a call alive past max_call_ms", async () => {
  const client = await open();
  const started = Date.now();
  await assert.rejects(
    client.callTool({ name: "alpha__sleep", arguments: { ms: 4000, progress_ms: 100 } }),
    (e: Error & { code?: number }) => e.code === -32002,
  );
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

/** Reads an SSE response until `done` says so; returns every `id:`/`data:` pair seen. */
async function readEvents(
  res: Response,
  done: (events: { id?: string; data: string }[]) => boolean,
): Promise<{ id?: string; data: string }[]> {
  const events: { id?: string; data: string }[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (!done(events)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      if (data.trim()) events.push({ id, data });
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

test("a dropped SSE stream resumes from Last-Event-ID instead of losing what it missed", async () => {
  const url = `${gateway.url}/mcp/default`;
  const version = "2025-06-18";
  const init = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "sse", version: "0" } },
    }),
  });
  const id = init.headers.get("mcp-session-id")!;
  await init.text();
  const headers = { "mcp-session-id": id, "mcp-protocol-version": version };
  await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const session = gateway.sessions.get(id)!;

  // 1. The standalone stream receives one notification, and its event id.
  const first = await fetch(url, { headers: { ...headers, accept: "text/event-stream" } });
  const sent = session.server.sendToolListChanged();
  const [delivered] = await readEvents(first, (e) => e.length >= 1);
  await sent;
  assert.match(delivered!.data, /notifications\/tools\/list_changed/);

  // 2. The stream is gone; the next notification has nowhere to go but the event store.
  await new Promise((r) => setTimeout(r, 100));
  await session.server.sendResourceListChanged();

  // 3. Reconnecting with the last id seen replays exactly what was missed.
  let resumed: Response;
  const deadline = Date.now() + 3000;
  do {
    resumed = await fetch(url, {
      headers: { ...headers, accept: "text/event-stream", "last-event-id": delivered!.id! },
    });
    if (resumed.status !== 409) break; // the old stream may not have been released yet
    await resumed.text();
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  assert.equal(resumed.status, 200);
  const [missed] = await readEvents(resumed, (e) => e.length >= 1);
  assert.match(missed!.data, /notifications\/resources\/list_changed/);

  await fetch(url, { method: "DELETE", headers });
});

test("the event store stays bounded by count and by bytes", async () => {
  const note = (n: number) => ({ jsonrpc: "2.0" as const, method: "n", params: { n } });

  const byCount = new RecentEvents(3, 1_000_000);
  const ids = [];
  for (let n = 0; n < 5; n++) ids.push(await byCount.storeEvent("s", note(n)));
  assert.equal(await byCount.getStreamIdForEventId(ids[0]!), undefined, "the oldest was evicted");
  const replayed: unknown[] = [];
  await byCount.replayEventsAfter(ids[2]!, { send: async (_id, m) => void replayed.push(m) });
  assert.deepEqual(replayed, [note(3), note(4)]);

  const byBytes = new RecentEvents(1000, 200);
  const big = { jsonrpc: "2.0" as const, method: "n", params: { pad: "x".repeat(150) } };
  const kept = await byBytes.storeEvent("s", big);
  const newest = await byBytes.storeEvent("s", big);
  assert.equal(await byBytes.getStreamIdForEventId(kept), undefined);
  assert.equal(await byBytes.getStreamIdForEventId(newest), "s", "the newest is never evicted");
});
