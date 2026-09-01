#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuditLine } from "./audit.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { BackendAuth, CALLBACK_PATH, CALLBACK_PORT, REDIRECT_URI, TokenStore } from "./oauth.js";
import { assemble, startGateway } from "./server.js";

/** SPEC §11: drain in-flight calls up to 5 s, then kill children and exit 0. */
const DRAIN_MS = 5000;

const USAGE = `mcpgw — MCP gateway

Usage:
  mcpgw start    [--config PATH] [--port N]              run the daemon
  mcpgw validate [--config PATH]                         check config.yaml
  mcpgw list     [--config PATH] [--profile P]           effective tools per profile, and why
  mcpgw pin      [--config PATH] [--server NAME] [--yes] review and accept tool changes
  mcpgw status   [--config PATH] [--json]                backends, uptime, restarts, drift
  mcpgw auth     SERVER [--config PATH] [--reset] [--print-url]
                                                         authorize an oauth backend in a browser
  mcpgw reload   [--config PATH]                         re-read the config in the running daemon
  mcpgw tail     [--config PATH] [--profile P] [--denied-only] [--follow]

Signals: SIGHUP reloads the config (POSIX only; on Windows use 'mcpgw reload').
         SIGTERM/SIGINT drain in-flight calls for up to 5 s, then exit.

Config is resolved as: --config PATH, then $MCPGW_CONFIG, then ./config.yaml.`;

/** Structured to stderr, with the one thing a human must actually read spelled out. */
function log(event: string, fields: Record<string, unknown> = {}): void {
  const { diff, ...rest } = fields as { diff?: string };
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...rest })}\n`);
  // A drift diff is the one thing here a human is meant to actually read.
  if (diff) {
    const indented = diff
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    process.stderr.write(`${indented}\n`);
  }
}

async function start(config: Config, configPath: string, port?: number): Promise<void> {
  const parts = assemble(config, configPath, log);

  // Bind before the backends connect: a slow `npx` cold start must never delay the port (NFR-6).
  const gateway = await startGateway(config, parts, { port, configPath });
  log("listening", { url: gateway.url, profiles: Object.keys(config.profiles) });

  const shutdown = (signal: string) => {
    log("draining", { signal, inflight: parts.pipeline.inflight });
    void gateway.close(DRAIN_MS).then(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  process.on("SIGHUP", () => {
    void (async () => {
      try {
        const { config: next } = loadConfig(configPath);
        await gateway.reload(next);
        log("reloaded", { config: configPath });
      } catch (e) {
        // A bad edit must not take the daemon down; keep serving the config that works.
        const problems = e instanceof ConfigError ? e.problems : [(e as Error).message];
        log("reload_failed", { problems });
      }
    })();
  });

  // Failures are logged and retried by the backend itself; nothing here blocks the listener.
  await parts.pool.start();
  const pending = parts.guard.pending();
  if (pending.length > 0) {
    log("drift_pending", { count: pending.length, hint: "run `mcpgw pin` to review" });
  }
}

/**
 * Answers "why can't the model see this tool" by printing every catalog entry with the rule
 * that decided it. Connects the backends, prints, exits — it never binds the port.
 */
async function list(config: Config, configPath: string, only?: string): Promise<number> {
  if (only && !(only in config.profiles)) {
    console.error(`no such profile: ${only}`);
    return 1;
  }
  const parts = assemble(config, configPath);
  await parts.pool.start();

  for (const profile of only ? [only] : Object.keys(config.profiles)) {
    const rows = parts.pipeline.explain(profile).sort((a, b) => a.exposed.localeCompare(b.exposed));
    const allowed = rows.filter((r) => r.decision.allow).length;
    console.log(`\nprofile ${profile}  (${allowed} of ${rows.length} tools exposed)`);
    for (const row of rows) {
      const renamed = row.exposed === row.entry.canonical ? "" : `  [${row.entry.canonical}]`;
      const verdict = row.decision.allow ? "allow" : row.decision.reason;
      console.log(`  ${verdict.padEnd(21)} ${row.exposed.padEnd(40)} ${row.decision.rule}${renamed}`);
    }
  }

  await parts.pool.close();
  await parts.audit.close();
  return 0;
}

/**
 * Shows every pending tool change and, with --yes, accepts it. There is deliberately no
 * auto-accept-on-drift and no interactive prompt: accepting is an explicit, scriptable act.
 */
async function pin(
  config: Config,
  configPath: string,
  opts: { server?: string; yes?: boolean },
): Promise<number> {
  const parts = assemble(config, configPath);
  await parts.pool.start();
  const pending = parts.guard.pending(opts.server);

  if (pending.length === 0) console.log("nothing pending; every tool matches its pin");

  for (const change of pending) {
    if (change.kind === "drift") {
      console.log(`\ndrift  ${change.server}__${change.tool}`);
      console.log(`  ${change.from.slice(0, 14)}… → ${change.to.slice(0, 14)}…`);
      for (const l of change.diff.split("\n")) console.log(`  ${l}`);
    } else if (change.kind === "removed") {
      console.log(`\nremoved  ${change.server}__${change.tool}  (pinned, no longer offered)`);
    }
  }

  if (pending.length > 0) {
    if (opts.yes) {
      parts.guard.accept(opts.server);
      console.log(`\naccepted ${pending.length} change(s); tools.lock.json updated`);
    } else {
      console.log(`\n${pending.length} change(s) pending. Re-run with --yes to accept.`);
    }
  }

  await parts.pool.close();
  await parts.audit.close();
  return pending.length > 0 && !opts.yes ? 1 : 0;
}

interface Health {
  status: string;
  uptime_s: number;
  sessions: number;
  pending_drift: number;
  backends: Record<
    string,
    { state: string; tools: number; restarts: number; pid: number | null; error?: string }
  >;
}

/** Best effort: the URL is always printed, so a failed opener costs nothing. */
function openBrowser(url: URL): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url.href]]
      : process.platform === "darwin"
        ? ["open", [url.href]]
        : ["xdg-open", [url.href]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The printed URL is the fallback.
  }
}

/** Catches the one redirect the authorization server sends back, then shuts itself down. */
function awaitCallback(auth: BackendAuth): { code: Promise<string>; close: () => void } {
  let settle: (code: string) => void;
  let fail: (e: Error) => void;
  const code = new Promise<string>((ok, no) => {
    settle = ok;
    fail = no;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const reply = (text: string) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${text}
`);
    };

    const error = url.searchParams.get("error");
    if (error) {
      reply(`Authorization failed: ${error}. You can close this tab.`);
      fail(new Error(`the authorization server said: ${error}`));
      return;
    }
    // The state check is what makes this callback unforgeable by another page in the browser.
    if (!auth.matchesState(url.searchParams.get("state"))) {
      reply("Rejected: state mismatch. You can close this tab.");
      fail(new Error("callback state did not match; authorization abandoned"));
      return;
    }
    const granted = url.searchParams.get("code");
    if (!granted) {
      reply("Rejected: no code. You can close this tab.");
      fail(new Error("callback carried no authorization code"));
      return;
    }
    reply("Authorized. You can close this tab and return to the terminal.");
    settle(granted);
  });

  server.listen(CALLBACK_PORT, "127.0.0.1");
  server.on("error", (e) => fail(e));
  return { code, close: () => server.close() };
}

/**
 * The whole interactive part of OAuth, in one explicit command. The daemon never opens a
 * browser on its own: an `auth: oauth` backend stays DOWN until this has been run once, after
 * which the refresh token in tokens.json carries it across restarts.
 */
async function authorize(
  config: Config,
  configPath: string,
  server: string | undefined,
  opts: { reset?: boolean; printUrl?: boolean } = {},
): Promise<number> {
  if (!server) {
    console.error("which server? usage: mcpgw auth SERVER");
    return 1;
  }
  const cfg = config.servers[server];
  if (!cfg) {
    console.error(`no such server: ${server}`);
    return 1;
  }
  if (cfg.transport === "stdio") {
    console.error(`${server} is a stdio server; it has no OAuth flow`);
    return 1;
  }
  if (cfg.auth !== "oauth") {
    console.error(`${server} is not configured with \`auth: oauth\``);
    return 1;
  }

  const store = new TokenStore(TokenStore.pathFor(configPath));
  if (opts.reset) store.clear(server, "all");

  const auth = new BackendAuth(server, store, {
    scope: cfg.scope,
    clientId: cfg.client_id,
    clientSecret: cfg.client_secret,
    onRedirect: (url) => {
      console.log(`
authorize ${server} here:
  ${url.href}
`);
      if (!opts.printUrl) openBrowser(url);
    },
  });

  const connect = async () => {
    const client = new Client({ name: "mcpgw-auth", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
      authProvider: auth,
    });
    await client.connect(transport);
    return { client, transport };
  };

  let listener: { code: Promise<string>; close: () => void } | undefined;
  try {
    try {
      const { client } = await connect();
      const { tools } = await client.listTools();
      await client.close();
      console.log(`${server} is already authorized (${tools.length} tools)`);
      return 0;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }

    // The redirect has been issued by now; catch the code it comes back with.
    listener = awaitCallback(auth);
    console.log("waiting for the redirect (Ctrl-C to abandon)…");
    const code = await Promise.race([
      listener.code,
      new Promise<never>((_, no) =>
        setTimeout(() => no(new Error("timed out after 5 minutes")), 300_000).unref(),
      ),
    ]);

    const exchange = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
      authProvider: auth,
    });
    await exchange.finishAuth(code);
    await exchange.close();

    const { client } = await connect();
    const { tools } = await client.listTools();
    await client.close();
    console.log(`
authorized ${server}: ${tools.length} tools reachable`);
    console.log(`tokens saved to ${store.path} — restart the daemon, or run \`mcpgw reload\``);
    return 0;
  } catch (e) {
    const message = (e as Error).message;
    console.error(`authorization failed: ${message}`);
    // The common case, and the SDK's error for it is unreadable: the server advertises dynamic
    // registration and then refuses it, which means it wants an OAuth app you created by hand.
    if (!cfg.client_id && /40[13]|Forbidden|registration/i.test(message)) {
      console.error(
        `
${server} appears to refuse dynamic client registration. Create an OAuth app with` +
          `
redirect URI ${REDIRECT_URI}, then add its credentials to the server block:
` +
          `
  ${server}:
    auth: oauth
    client_id: \${${server.toUpperCase()}_CLIENT_ID}` +
          `
    client_secret: \${${server.toUpperCase()}_CLIENT_SECRET}
`,
      );
    }
    return 1;
  } finally {
    listener?.close();
  }
}

/** Same reload the daemon does on SIGHUP, reachable on platforms that have no such signal. */
async function reload(config: Config): Promise<number> {
  const url = `http://${config.listen.host}:${config.listen.port}/reload`;
  const headers: Record<string, string> = config.listen.token
    ? { Authorization: `Bearer ${config.listen.token}` }
    : {};
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    console.error(`no daemon answering at ${url}`);
    return 1;
  }
  const body = (await res.json()) as { status: string; problems?: string[] };
  if (res.ok) {
    console.log(`reloaded ${config.listen.host}:${config.listen.port}`);
    return 0;
  }
  console.error("reload rejected; the daemon is still serving the previous config:");
  for (const problem of body.problems ?? []) console.error(`  - ${problem}`);
  return 1;
}

/** Asks the running daemon, rather than guessing from the config. */
async function status(config: Config, asJson?: boolean): Promise<number> {
  const url = `http://${config.listen.host}:${config.listen.port}/healthz`;
  let health: Health;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`${res.status}`);
    health = (await res.json()) as Health;
  } catch {
    console.error(`no daemon answering at ${url}`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(health, null, 2));
    return 0;
  }

  const mins = Math.floor(health.uptime_s / 60);
  console.log(
    `up ${mins}m  ${health.sessions} session(s)  ${health.pending_drift} pending drift`,
  );
  for (const [name, b] of Object.entries(health.backends)) {
    const detail = b.state === "up" ? `${b.tools} tools  pid ${b.pid}` : (b.error ?? "");
    const restarts = b.restarts > 0 ? `  ${b.restarts} restart(s)` : "";
    console.log(`  ${b.state.padEnd(11)} ${name.padEnd(16)} ${detail}${restarts}`);
  }
  return Object.values(health.backends).some((b) => b.state !== "up") ? 1 : 0;
}

function renderAudit(line: AuditLine): string {
  const time = line.ts.slice(11, 23);
  const what = line.tool ? `${line.server}__${line.tool}` : (line.server ?? "");
  const as = line.exposed_as && line.exposed_as !== what ? ` as ${line.exposed_as}` : "";
  const took = line.dur_ms === undefined ? "" : ` ${line.dur_ms}ms`;
  const err = line.error ? `  ${line.error.code} ${line.error.message}` : "";
  const verdict = line.decision ?? line.method;
  return `${time} ${(line.profile ?? "-").padEnd(10)} ${verdict.padEnd(21)} ${what}${as}${took}${err}`;
}

async function tail(
  config: Config,
  opts: { profile?: string; deniedOnly?: boolean; follow?: boolean },
): Promise<number> {
  const dir = config.audit.dir;
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];
  const newest = files.pop();
  if (!newest) {
    console.error(`no audit files in ${dir}`);
    return 1;
  }
  const path = join(dir, newest);

  const show = (raw: string) => {
    if (!raw.trim()) return;
    let line: AuditLine;
    try {
      line = JSON.parse(raw) as AuditLine;
    } catch {
      return;
    }
    if (opts.profile && line.profile !== opts.profile) return;
    if (opts.deniedOnly && (line.decision ?? "allow") === "allow") return;
    console.log(renderAudit(line));
  };

  const readFrom = async (offset: number): Promise<number> => {
    const size = (await stat(path)).size;
    if (size <= offset) return offset;
    const stream = createReadStream(path, { start: offset, end: size - 1 });
    for await (const raw of createInterface({ input: stream })) show(raw);
    return size;
  };

  let offset = await readFrom(0);
  if (!opts.follow) return 0;

  // ponytail: polls rather than watching. fs.watch semantics differ per platform, and this is a
  // human staring at a terminal — a 500 ms poll is indistinguishable and always correct.
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    offset = await readFrom(offset);
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      profile: { type: "string" },
      server: { type: "string" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
      reset: { type: "boolean" },
      "print-url": { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      "denied-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  const known = ["start", "validate", "list", "pin", "tail", "status", "reload", "auth"];

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!known.includes(command)) {
    console.error(`mcpgw: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  let config: Config;
  let path: string;
  try {
    ({ config, path } = loadConfig(values.config));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error("config is invalid:");
    for (const problem of e.problems) console.error(`  - ${problem}`);
    return 1;
  }

  switch (command) {
    case "validate": {
      const servers = Object.keys(config.servers).length;
      const profiles = Object.keys(config.profiles).length;
      console.log(`ok  ${path}  (${servers} servers, ${profiles} profiles)`);
      return 0;
    }
    case "list":
      return list(config, path, values.profile);
    case "pin":
      return pin(config, path, { server: values.server, yes: values.yes });
    case "status":
      return status(config, values.json);
    case "reload":
      return reload(config);
    case "auth":
      return authorize(config, path, positionals[1], {
        reset: values.reset,
        printUrl: values["print-url"],
      });
    case "tail":
      return tail(config, {
        profile: values.profile,
        deniedOnly: values["denied-only"],
        follow: values.follow,
      });
    default:
      await start(config, path, values.port === undefined ? undefined : Number(values.port));
      return 0; // the process stays alive on the listener
  }
}

process.exitCode = await main(process.argv.slice(2));
