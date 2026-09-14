// Managing the gateway from the status page: the stop route, the management flag the page reads,
// the Origin the page sends from a LAN name, and the audit line every action leaves.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { recentLines } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assemble, startGateway, type Gateway, type Parts } from "../src/server.js";

const TOKEN = "manage-test-token";
const fixture = fileURLToPath(new URL("./fixture-server.js", import.meta.url));

/** A gateway on its own config file; `token` decides whether management is on at all. */
async function launch(token: string | undefined, onStop?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "mcpgw-manage-"));
  const configPath = join(dir, "config.yaml");
  const text = (servers: string) => `version: 1
${token ? `listen:\n  token: ${token}\n` : ""}audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
servers:
${servers}
profiles:
  default:
    servers: ["*"]
`;
  const alpha = `  alpha:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(fixture)}]`;
  writeFileSync(configPath, text(alpha));
  const { config } = loadConfig(configPath);
  const parts = assemble(config, configPath);
  const gateway = await startGateway(config, parts, { port: 0, configPath, onStop });
  await parts.pool.start();
  return { gateway, parts, configPath, rewrite: (servers: string) => writeFileSync(configPath, text(servers)) };
}

const auth = { authorization: `Bearer ${TOKEN}` };
let stops = 0;
let managed: Awaited<ReturnType<typeof launch>>;
let open: Awaited<ReturnType<typeof launch>>;

before(async () => {
  managed = await launch(TOKEN, () => stops++);
  open = await launch(undefined, () => stops++);
});

after(async () => {
  await managed?.gateway.close();
  await open?.gateway.close();
});

async function manageLines(parts: Parts) {
  await parts.audit.flush();
  return recentLines(parts.audit.dir, 100).filter((l) => l.method === "manage");
}

test("healthz tells the status page whether it may offer management", async () => {
  const on = (await (await fetch(`${managed.gateway.url}/healthz`, { headers: auth })).json()) as { manage: boolean };
  assert.equal(on.manage, true);
  const off = (await (await fetch(`${open.gateway.url}/healthz`)).json()) as { manage?: boolean };
  assert.equal(off.manage, false, "no token set, so no buttons");
});

test("stop needs a token configured, then the token, and only then stops", async () => {
  const before = stops;

  const tokenless = await fetch(`${open.gateway.url}/stop`, { method: "POST" });
  assert.equal(tokenless.status, 403, "loopback reachability alone must not stop the gateway");

  assert.equal((await fetch(`${managed.gateway.url}/stop`)).status, 405);
  assert.equal((await fetch(`${managed.gateway.url}/stop`, { method: "POST" })).status, 401);
  assert.equal(stops, before, "a refused stop still stopped");

  const res = await fetch(`${managed.gateway.url}/stop`, { method: "POST", headers: auth });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "stopping" });
  // onStop runs once the answer has been written, not before.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, before + 1);

  const lines = await manageLines(managed.parts);
  assert.ok(lines.some((l) => l.action === "stop" && l.status === "ok" && l.remote));
});

test("a gateway started without onStop refuses to be stopped over HTTP", async () => {
  const bare = await launch(TOKEN);
  try {
    const res = await fetch(`${bare.gateway.url}/stop`, { method: "POST", headers: auth });
    assert.equal(res.status, 404);
  } finally {
    await bare.gateway.close();
  }
});

/** node:http, because fetch will not send a Host that differs from the URL. */
function viaLanName(gateway: Gateway, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    request(`${gateway.url}/reload`, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

test("the page's own LAN origin may act with the token; any other origin may not", async () => {
  const host = "gateway.lan:8420";
  const own = await viaLanName(managed.gateway, { host, origin: `https://${host}`, ...auth });
  assert.equal(own, 200, "the status page served from a LAN name could not press its own buttons");

  const other = await viaLanName(managed.gateway, { host, origin: "https://evil.example", ...auth });
  assert.equal(other, 403);

  // Without a token the Host must be loopback, so a matching non-loopback Origin changes nothing.
  const tokenless = await viaLanName(open.gateway, { host, origin: `https://${host}` });
  assert.equal(tokenless, 403);
});

test("reload and restart leave a manage line, failures included", async () => {
  const url = managed.gateway.url;
  assert.equal((await fetch(`${url}/restart/alpha`, { method: "POST", headers: auth })).status, 200);

  managed.rewrite("  broken: { transport: stdio }");
  const bad = await fetch(`${url}/reload`, { method: "POST", headers: auth });
  assert.equal(bad.status, 400);

  const lines = await manageLines(managed.parts);
  assert.ok(lines.some((l) => l.action === "restart" && l.server === "alpha" && l.status === "ok"));
  const failed = lines.find((l) => l.action === "reload" && l.status === "error");
  assert.ok(failed, "a rejected reload left no line");
  assert.ok(Array.isArray(failed.problems) && failed.problems.length > 0);
});

test("the status page ships its controls, and they call the gated routes", async () => {
  const script = await (await fetch(`${managed.gateway.url}/dashboard.js`)).text();
  for (const route of ['"/reload"', '"/stop"', '"/restart/"']) assert.ok(script.includes(route), route);
  assert.match(script, /body\.manage/, "controls must depend on the manage flag");

  // The controls and the login form are display:flex, which beats the `hidden` attribute unless
  // the page says otherwise: logged out, the stop button showed.
  const page = await (await fetch(`${managed.gateway.url}/dashboard`)).text();
  assert.match(page, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(page, /<div id="controls" hidden>/);
});
