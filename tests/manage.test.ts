// Managing the gateway from the status page: the stop route, the management flag the page reads,
// the Origin the page sends from a LAN name, and the audit line every action leaves.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { recentLines } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assemble, fromThisMachine, startGateway, type Gateway, type Parts } from "../src/server.js";

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
    servers: ["*"]   # every server
  renamed:
    servers: ["*"]
    rename: { alpha__echo: shout }
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

test("the config-writing routes need a token configured and presented", async () => {
  for (const [method, path] of [
    ["POST", "/servers/alpha/disable"],
    ["GET", "/profiles/default/tools"],
    ["POST", "/profiles/default/tools/alpha__echo/disable"],
  ] as const) {
    assert.equal((await fetch(`${open.gateway.url}${path}`, { method })).status, 403, path);
    assert.equal((await fetch(`${managed.gateway.url}${path}`, { method })).status, 401, path);
  }
  const url = managed.gateway.url;
  assert.equal((await fetch(`${url}/servers/nope/disable`, { method: "POST", headers: auth })).status, 404);
  assert.equal((await fetch(`${url}/profiles/nope/tools`, { headers: auth })).status, 404);
  const bare = await fetch(`${url}/profiles/default/tools/echo/disable`, { method: "POST", headers: auth });
  assert.equal(bare.status, 400, "a tool name without its server");
});

type Health = { backends: Record<string, { state: string }>; disabled: string[]; profiles: string[] };
type Tools = { tools: Array<{ canonical: string; allow: boolean; rule: string; toggle: string | null }> };

test("disabling a server writes the flag, stops it, and enabling brings it back", async () => {
  const g = await launch(TOKEN);
  try {
    const url = g.gateway.url;
    const off = await fetch(`${url}/servers/alpha/disable`, { method: "POST", headers: auth });
    assert.equal(off.status, 200);
    assert.match(readFileSync(g.configPath, "utf8"), /\n {4}disabled: true\n/);
    assert.match(readFileSync(g.configPath, "utf8"), /# every server/, "a comment was lost");

    let health = (await (await fetch(`${url}/healthz`, { headers: auth })).json()) as Health;
    assert.equal(health.backends.alpha, undefined, "the backend is still running");
    assert.deepEqual(health.disabled, ["alpha"]);
    assert.deepEqual(health.profiles, ["default", "renamed"]);

    assert.equal((await fetch(`${url}/servers/alpha/enable`, { method: "POST", headers: auth })).status, 200);
    health = (await (await fetch(`${url}/healthz`, { headers: auth })).json()) as Health;
    assert.equal(health.backends.alpha?.state, "up");
    assert.deepEqual(health.disabled, []);

    const actions = (await manageLines(g.parts)).map((l) => `${l.action}:${l.status}`);
    assert.deepEqual(actions, ["disable_server:ok", "enable_server:ok"]);
  } finally {
    await g.gateway.close();
  }
});

test("a tool is switched off and on per profile through its exact deny entry", async () => {
  const g = await launch(TOKEN);
  try {
    const url = g.gateway.url;
    const tools = async (profile: string) =>
      ((await (await fetch(`${url}/profiles/${profile}/tools`, { headers: auth })).json()) as Tools).tools;
    const echo = async (profile: string) => (await tools(profile)).find((t) => t.canonical === "alpha__echo")!;

    assert.equal((await echo("default")).toggle, "disable");
    const off = await fetch(`${url}/profiles/default/tools/alpha__echo/disable`, { method: "POST", headers: auth });
    assert.equal(off.status, 200);
    const denied = await echo("default");
    assert.deepEqual([denied.allow, denied.rule, denied.toggle], [false, "deny: alpha__echo", "enable"]);
    assert.equal((await echo("renamed")).allow, true, "another profile was affected");

    assert.equal(
      (await fetch(`${url}/profiles/default/tools/alpha__echo/enable`, { method: "POST", headers: auth })).status,
      200,
    );
    assert.equal((await echo("default")).allow, true);

    // Denying a renamed tool would leave an alias that can never be exposed: refused, file untouched.
    const before = readFileSync(g.configPath, "utf8");
    const bad = await fetch(`${url}/profiles/renamed/tools/alpha__echo/disable`, { method: "POST", headers: auth });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { problems: string[] }).problems.join(), /denied by this profile/);
    assert.equal(readFileSync(g.configPath, "utf8"), before);
    assert.ok((await manageLines(g.parts)).some((l) => l.action === "disable_tool" && l.status === "error"));
  } finally {
    await g.gateway.close();
  }
});

test("the status page ships its controls, and they call the gated routes", async () => {
  const script = await (await fetch(`${managed.gateway.url}/dashboard.js`)).text();
  for (const route of ['"/reload"', '"/stop"', '"/restart/"']) assert.ok(script.includes(route), route);
  assert.match(script, /body\.manage/, "controls must depend on the manage flag");
  // Found in the browser: a stopped gateway kept reading "up", a slow load could overwrite typing,
  // and a button's save left the editor on the old file.
  assert.match(script, /get\("\/healthz"\)\.catch\(/, "a failed refresh must show the gateway as down");
  assert.match(script, /readOnly = true/, "the editor must be locked while it loads");
  assert.match(script, /!== editorText/, "a button's save must re-sync an untouched editor");

  // The controls and the login form are display:flex, which beats the `hidden` attribute unless
  // the page says otherwise: logged out, the stop button showed.
  const page = await (await fetch(`${managed.gateway.url}/dashboard`)).text();
  assert.match(page, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(page, /<div id="controls" hidden>/);
});

test("the config editor loads, validates, and saves only over the text it loaded", async () => {
  const g = await launch(TOKEN);
  try {
    const url = g.gateway.url;
    const json = { ...auth, "content-type": "application/json" };
    const health = (await (await fetch(`${url}/healthz`, { headers: auth })).json()) as { editor: boolean };
    assert.equal(health.editor, true, "a loopback request with the token should get the editor");

    const loaded = (await (await fetch(`${url}/config`, { headers: auth })).json()) as { text: string; hash: string };
    assert.equal(loaded.text, readFileSync(g.configPath, "utf8"));

    const invalid = await fetch(`${url}/config/validate`, {
      method: "POST", headers: json, body: JSON.stringify({ text: "version: 2\n" }),
    });
    assert.equal(invalid.status, 400);
    const valid = await fetch(`${url}/config/validate`, {
      method: "POST", headers: json, body: JSON.stringify({ text: loaded.text }),
    });
    assert.deepEqual(await valid.json(), { status: "valid", restart_needed: false });

    // Invalid text: refused, file untouched.
    const bad = await fetch(`${url}/config`, {
      method: "PUT", headers: json, body: JSON.stringify({ text: "servers: nope\n", base_hash: loaded.hash }),
    });
    assert.equal(bad.status, 400);
    assert.equal(readFileSync(g.configPath, "utf8"), loaded.text);

    // A good save: written, reloaded, and the answer carries the new hash.
    const edited = loaded.text.replace("  renamed:\n", "  extra:\n    servers: [alpha]\n  renamed:\n");
    const ok = await fetch(`${url}/config`, {
      method: "PUT", headers: json, body: JSON.stringify({ text: edited, base_hash: loaded.hash }),
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as { hash: string; restart_needed: boolean };
    assert.equal(saved.restart_needed, false);
    assert.equal(readFileSync(g.configPath, "utf8"), edited);
    assert.equal(readFileSync(`${g.configPath}.bak`, "utf8"), loaded.text);
    const after = (await (await fetch(`${url}/healthz`, { headers: auth })).json()) as { profiles: string[] };
    assert.ok(after.profiles.includes("extra"), "the save was not reloaded");

    // The stale hash from the first load: someone else's save must not be overwritten.
    const stale = await fetch(`${url}/config`, {
      method: "PUT", headers: json, body: JSON.stringify({ text: loaded.text, base_hash: loaded.hash }),
    });
    assert.equal(stale.status, 409);
    assert.equal(readFileSync(g.configPath, "utf8"), edited);

    // A listen change is saved, but flagged: the port is only bound at start.
    const moved = edited.replace(`token: ${TOKEN}`, `token: ${TOKEN}\n  port: 8499`);
    const listen = await fetch(`${url}/config`, {
      method: "PUT", headers: json, body: JSON.stringify({ text: moved, base_hash: saved.hash }),
    });
    assert.equal(listen.status, 200);
    assert.equal(((await listen.json()) as { restart_needed: boolean }).restart_needed, true);

    const actions = (await manageLines(g.parts)).map((l) => `${l.action}:${l.status}`);
    assert.deepEqual(actions, ["edit_config:error", "edit_config:ok", "edit_config:error", "edit_config:ok"]);
  } finally {
    await g.gateway.close();
  }
});

test("the config editor needs a token configured and presented", async () => {
  assert.equal((await fetch(`${open.gateway.url}/config`)).status, 403);
  assert.equal((await fetch(`${managed.gateway.url}/config`)).status, 401);
  const off = (await (await fetch(`${open.gateway.url}/healthz`)).json()) as { editor?: boolean };
  assert.notEqual(off.editor, true);
});

test("only a request from this machine counts as local for the editor", () => {
  const from = (remoteAddress: string | undefined) => fromThisMachine({ socket: { remoteAddress } } as never);
  assert.equal(from("127.0.0.1"), true);
  assert.equal(from("::1"), true);
  assert.equal(from("::ffff:127.0.0.1"), true);
  assert.equal(from("192.168.1.20"), false);
  assert.equal(from("::ffff:10.0.0.5"), false);
  assert.equal(from(undefined), false);
});
