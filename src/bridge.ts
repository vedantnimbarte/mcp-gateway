#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const USAGE = `mcpgw-bridge — stdio ⇄ gateway shim, for clients that only speak stdio

Usage:
  mcpgw-bridge --url http://127.0.0.1:8420/mcp/<profile> [--token TOKEN]`;

function die(message: string): never {
  process.stderr.write(`mcpgw-bridge: ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: { url: { type: "string" }, token: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help || !values.url) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 1);
}

let url: URL;
try {
  url = new URL(values.url);
} catch {
  die(`not a valid URL: ${values.url}`);
}

// Fail loudly and immediately rather than looking alive and timing out on the first tool call.
const health = new URL("/healthz", url);
try {
  const probe = await fetch(health, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) die(`gateway at ${health.origin} answered ${probe.status}; is it healthy?`);
} catch {
  die(`no gateway at ${health.origin} — start it with \`mcpgw start\``);
}

const headers = values.token ? { Authorization: `Bearer ${values.token}` } : undefined;
const upstream = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
const downstream = new StdioServerTransport();

// A pipe, not a proxy: nothing here interprets, rewrites or validates a message (SPEC §10.2).
upstream.onmessage = (message) => void downstream.send(message);
downstream.onmessage = (message) => void upstream.send(message);

upstream.onerror = (e) => die(`gateway connection failed: ${e.message}`);
upstream.onclose = () => process.exit(0);
downstream.onclose = () => void upstream.close().then(() => process.exit(0));

await upstream.start();
await downstream.start();
