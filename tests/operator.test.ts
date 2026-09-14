// Phase 10: the daemon over TLS, the read-only status page, and the audit tail it reads.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { recentLines, type AuditLine } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const TOKEN = "operator-test-token";
const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
// Test-only certificate for 127.0.0.1, committed so the suite needs no openssl.
const certPath = fileURLToPath(new URL("../../tests/fixtures/tls-cert.pem", import.meta.url));
const keyPath = fileURLToPath(new URL("../../tests/fixtures/tls-key.pem", import.meta.url));
const ca = readFileSync(certPath);
const dir = mkdtempSync(join(tmpdir(), "mcpgw-operator-"));
const configPath = join(dir, "config.yaml");

let gateway: Gateway;
let parts: Parts;

before(async () => {
  writeFileSync(
    configPath,
    `version: 1
listen:
  token: ${TOKEN}
  tls:
    cert: ${JSON.stringify(certPath)}
    key: ${JSON.stringify(keyPath)}
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
  parts = assemble(config, configPath);
  gateway = await startGateway(config, parts, { port: 0 });
  await parts.pool.start();
});

after(async () => {
  await gateway?.close();
});

/** `fetch` cannot be handed a CA, so this goes through node:https, trusting only the test cert. */
function get(path: string, token?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      request(`${gateway.url}${path}`, { ca, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
        .on("error", reject)
        .end();
    },
  );
}

test("with listen.tls the daemon serves HTTPS, and the token still guards the detail", async () => {
  assert.match(gateway.url, /^https:\/\//);
  assert.deepEqual(JSON.parse((await get("/healthz")).body), { status: "ok" });
  const detail = JSON.parse((await get("/healthz", TOKEN)).body);
  assert.equal(detail.backends.alpha.state, "up");
});

test("the status page is served to anyone, locked down, and carries no data of its own", async () => {
  const page = await get("/dashboard");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.body, /alpha/, "backend names must come from the token-gated fetch");

  const script = await get("/dashboard.js");
  assert.equal(script.status, 200);
  assert.match(String(script.headers["content-type"]), /javascript/);
});

test("the audit tail needs the token, and a refused token is itself audited", async () => {
  const refused = await get("/audit/recent");
  assert.equal(refused.status, 401);

  await parts.audit.flush();
  const lines = recentLines(parts.audit.dir, 50);
  assert.ok(
    lines.some((l) => l.method === "unauthorized" && l.path === "/audit/recent"),
    "a refused token leaves a line",
  );

  const allowed = await get("/audit/recent?n=5&denied=1", TOKEN);
  assert.equal(allowed.status, 200);
  const body = JSON.parse(allowed.body) as { lines: AuditLine[] };
  assert.ok(body.lines.length <= 5);
  assert.ok(body.lines.every((l) => l.decision !== "allow" || l.status === "error"));
});

test("recentLines reads only the newest file's tail and survives a torn line", () => {
  const audit = mkdtempSync(join(tmpdir(), "mcpgw-recent-"));
  writeFileSync(join(audit, "2026-01-01.jsonl"), `${JSON.stringify({ method: "old" })}\n`);
  const today = [
    { method: "tools/call", decision: "allow", status: "ok" },
    { method: "tools/call", decision: "denied_by_policy", status: "denied" },
    { method: "tools/call", decision: "allow", status: "error" },
  ];
  writeFileSync(
    join(audit, "2026-01-02.jsonl"),
    `${today.map((l) => JSON.stringify(l)).join("\n")}\n{"method":"torn`,
  );

  assert.deepEqual(
    recentLines(audit, 10).map((l) => l.status),
    ["ok", "denied", "error"],
    "yesterday's file is not read, and the torn line is skipped",
  );
  assert.deepEqual(recentLines(audit, 10, true).map((l) => l.status), ["denied", "error"]);
  assert.deepEqual(recentLines(audit, 1).map((l) => l.status), ["error"]);
  assert.deepEqual(recentLines(join(audit, "missing"), 10), []);
});
