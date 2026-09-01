import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { BackendAuth, NeedsAuthorization, TokenStore } from "../src/oauth.js";
import { Pool } from "../src/pool.js";
import { startFakeProvider, type FakeProvider } from "./oauth-server.js";

const dir = mkdtempSync(join(tmpdir(), "mcpgw-oauth-"));
const configPath = join(dir, "config.yaml");
let provider: FakeProvider;
let store: TokenStore;

/** Plays the browser: follows the authorize redirect and reads the code back off it. */
async function actAsBrowser(url: URL): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  assert.ok(location, `authorize did not redirect: ${res.status}`);
  return new URL(location).searchParams.get("code") ?? "";
}

before(async () => {
  provider = await startFakeProvider();
  writeFileSync(
    configPath,
    `version: 1
audit:
  dir: ${JSON.stringify(join(dirname(configPath), "audit"))}
servers:
  protected:
    transport: http
    url: ${JSON.stringify(provider.mcpUrl)}
    auth: oauth
profiles:
  default:
    servers: ["*"]
`,
  );
  store = new TokenStore(TokenStore.pathFor(configPath));
});

after(async () => {
  await provider?.close();
});

test("the token store persists across processes and keeps its parts separate", () => {
  const path = join(dir, "scratch-tokens.json");
  const first = new TokenStore(path);
  first.set("srv", { tokens: { access_token: "a", token_type: "Bearer" } });
  first.set("srv", { verifier: "v", client: { client_id: "c" } });

  const reopened = new TokenStore(path);
  assert.equal(reopened.get("srv").tokens?.access_token, "a");
  assert.equal(reopened.get("srv").verifier, "v");
  assert.equal(reopened.get("srv").client?.client_id, "c");

  reopened.clear("srv", "tokens");
  assert.equal(new TokenStore(path).get("srv").tokens, undefined);
  assert.equal(new TokenStore(path).get("srv").client?.client_id, "c", "clearing tokens keeps the registration");
});

test("the callback state must match the one that was issued", () => {
  const auth = new BackendAuth("srv", new TokenStore(join(dir, "state-tokens.json")));
  const issued = auth.state();

  assert.equal(auth.matchesState(issued), true);
  assert.equal(auth.matchesState("not-it"), false);
  assert.equal(auth.matchesState(null), false);
  assert.equal(auth.matchesState(""), false);
  assert.equal(auth.matchesState(`${issued}x`), false, "a longer string must not match");
});

test("a daemon with no browser refuses rather than stalling", () => {
  const auth = new BackendAuth("srv", new TokenStore(join(dir, "headless-tokens.json")));
  assert.throws(() => auth.redirectToAuthorization(new URL("https://example.com/authorize")), NeedsAuthorization);
});

test("an unauthorized backend goes DOWN with an instruction, and stops retrying", async () => {
  const { config } = loadConfig(configPath);
  const pool = new Pool(config, () => {}, undefined, (name) => new BackendAuth(name, store));
  await pool.start();

  const backend = pool.backends.get("protected")!;
  assert.equal(backend.state, "down");
  assert.equal(backend.needsAuth, true);
  assert.match(String(backend.lastError), /needs authorization: run `mcpgw auth protected`/);

  // Retrying an expired authorization only burns backoff; nothing should be scheduled.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(backend.state, "down", "it must not thrash while waiting for a human");
  await pool.close();
});

test("the authorization flow registers, exchanges with PKCE, and stores a refresh token", async () => {
  const auth = new BackendAuth("protected", store, {
    onRedirect: (url) => {
      pending = actAsBrowser(url);
    },
  });
  let pending: Promise<string> | undefined;

  const transport = () =>
    new StreamableHTTPClientTransport(new URL(provider.mcpUrl), { authProvider: auth });

  // First contact: 401, discovery, dynamic registration, redirect.
  const cold = new Client({ name: "auth-test", version: "0.0.0" });
  await assert.rejects(cold.connect(transport()), UnauthorizedError);
  assert.equal(provider.registrations, 1, "the client registered itself");

  const code = await pending!;
  assert.ok(code, "the fake browser came back with a code");

  const exchange = transport();
  await exchange.finishAuth(code);
  await exchange.close();

  const saved = JSON.parse(readFileSync(store.path, "utf8"));
  assert.match(saved.servers.protected.tokens.access_token, /^access-/);
  assert.match(saved.servers.protected.tokens.refresh_token, /^refresh-/);
  assert.ok(saved.servers.protected.client.client_id, "the registration is kept for next time");

  // And the connection now works.
  const warm = new Client({ name: "auth-test", version: "0.0.0" });
  await warm.connect(transport());
  assert.deepEqual((await warm.listTools()).tools.map((t) => t.name), ["secret"]);
  await warm.close();
});

test("a saved token brings the backend up with no browser at all", async () => {
  const { config } = loadConfig(configPath);
  const fresh = new TokenStore(TokenStore.pathFor(configPath));
  const pool = new Pool(config, () => {}, undefined, (name) => new BackendAuth(name, fresh));
  await pool.start();

  const backend = pool.backends.get("protected")!;
  assert.equal(backend.state, "up", backend.lastError ?? "");
  assert.equal(backend.needsAuth, false);
  assert.deepEqual(backend.tools.map((t) => t.name), ["secret"]);

  assert.deepEqual(await backend.callTool("secret", { of: "the gateway" }), {
    content: [{ type: "text", text: "secret of the gateway" }],
  });
  await pool.close();
});

test("an expired access token is refreshed without asking anyone", async () => {
  const before = JSON.parse(readFileSync(store.path, "utf8")).servers.protected.tokens.access_token;
  provider.expireTokens();

  const auth = new BackendAuth("protected", new TokenStore(TokenStore.pathFor(configPath)), {
    onRedirect: () => assert.fail("a refresh must not need the browser"),
  });
  const client = new Client({ name: "refresh-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(provider.mcpUrl), { authProvider: auth }),
  );

  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["secret"]);
  const after = JSON.parse(readFileSync(store.path, "utf8")).servers.protected.tokens.access_token;
  assert.notEqual(after, before, "a new access token was obtained with the refresh token");
  assert.equal(provider.registrations, 1, "and it did not re-register to do it");
  await client.close();
});

test("a server that refuses dynamic registration works with a configured client", async () => {
  // What Figma does: it advertises a registration endpoint, 403s it, and only accepts
  // client_secret_* at the token endpoint. A hand-made OAuth app is the only way in.
  const strict = await startFakeProvider({
    allowRegistration: false,
    requireClient: { id: "preregistered-app", secret: "s3cret" },
  });
  try {
    const store = new TokenStore(join(dir, "strict-tokens.json"));
    let pending: Promise<string> | undefined;
    const auth = new BackendAuth("strict", store, {
      clientId: "preregistered-app",
      clientSecret: "s3cret",
      onRedirect: (url) => {
        pending = actAsBrowser(url);
      },
    });
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(strict.mcpUrl), { authProvider: auth });

    const cold = new Client({ name: "strict-test", version: "0.0.0" });
    await assert.rejects(cold.connect(transport()), UnauthorizedError);
    assert.equal(strict.registrations, 0, "a configured client must not attempt registration");

    const exchange = transport();
    await exchange.finishAuth(await pending!);
    await exchange.close();

    const warm = new Client({ name: "strict-test", version: "0.0.0" });
    await warm.connect(transport());
    assert.deepEqual((await warm.listTools()).tools.map((t) => t.name), ["secret"]);
    await warm.close();

    const saved = JSON.parse(readFileSync(store.path, "utf8"));
    assert.equal(saved.servers.strict.client, undefined, "a configured client is not re-saved");
    assert.match(saved.servers.strict.tokens.refresh_token, /^refresh-/);
  } finally {
    await strict.close();
  }
});

test("the wrong client secret is rejected, not silently downgraded", async () => {
  const strict = await startFakeProvider({
    allowRegistration: false,
    requireClient: { id: "preregistered-app", secret: "s3cret" },
  });
  try {
    let pending: Promise<string> | undefined;
    const auth = new BackendAuth("wrong", new TokenStore(join(dir, "wrong-tokens.json")), {
      clientId: "preregistered-app",
      clientSecret: "not-the-secret",
      onRedirect: (url) => {
        pending = actAsBrowser(url);
      },
    });
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(strict.mcpUrl), { authProvider: auth });

    await assert.rejects(new Client({ name: "w", version: "0" }).connect(transport()), UnauthorizedError);
    await assert.rejects(transport().finishAuth(await pending!));
  } finally {
    await strict.close();
  }
});
