import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
const bridge = fileURLToPath(new URL("../src/bridge.js", import.meta.url));
const run = promisify(execFile);

const configPath = join(mkdtempSync(join(tmpdir(), "mcpgw-bridge-")), "config.yaml");
writeFileSync(
  configPath,
  `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
  fixture:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]
profiles:
  default:
    servers: ["*"]
`,
);

let gateway: Gateway;

before(async () => {
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await gateway?.close();
});

test("a stdio-only client reaches the gateway through the bridge", async () => {
  // Exactly how Claude Desktop or Cursor would launch it.
  const client = new Client({ name: "stdio-only-client", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bridge, "--url", `${gateway.url}/mcp/default`],
      stderr: "inherit",
    }),
  );

  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("fixture__echo"), `saw: ${names.join(", ")}`);

    assert.deepEqual(
      await client.callTool({ name: "fixture__echo", arguments: { message: "through the pipe" } }),
      { content: [{ type: "text", text: "through the pipe" }] },
    );

    // Policy still applies: the bridge interprets nothing, it only carries.
    await assert.rejects(
      client.callTool({ name: "fixture__nope", arguments: {} }),
      (e: Error & { code?: number }) => e.code === -32601,
    );
  } finally {
    await client.close();
  }
});

test("with no daemon it fails immediately and says why", async () => {
  // Port 1 is never a gateway.
  await assert.rejects(
    run(process.execPath, [bridge, "--url", "http://127.0.0.1:1/mcp/default"]),
    (e: Error & { code?: number; stderr?: string }) => {
      assert.equal(e.code, 1, "a dead daemon must be a non-zero exit, not a hang");
      assert.match(String(e.stderr), /no gateway at http:\/\/127\.0\.0\.1:1 — start it with/);
      return true;
    },
  );
});

test("without a --url it prints usage rather than guessing", async () => {
  await assert.rejects(
    run(process.execPath, [bridge]),
    (e: Error & { code?: number; stdout?: string }) => {
      assert.equal(e.code, 1);
      assert.match(String(e.stdout), /--url http:\/\/127\.0\.0\.1:8420\/mcp/);
      return true;
    },
  );
});
