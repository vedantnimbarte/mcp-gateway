import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server as NetServer } from "node:net";
import { dirname } from "node:path";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AuditLog, recentLines } from "./audit.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard.js";
import { ConfigError, isLoopback, loadConfig, type Config } from "./config.js";
import { Guard } from "./guard.js";
import { BackendAuth, TokenStore } from "./oauth.js";
import { Pipeline } from "./pipeline.js";
import { Pool } from "./pool.js";
import { SessionManager } from "./session.js";

/** SPEC §10.1. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface Gateway {
  port: number;
  url: string;
  sessions: SessionManager;
  /** SIGHUP. Restarts only the backends whose definition changed. */
  reload(config: Config): Promise<void>;
  /** SIGTERM. Stops accepting work, waits up to `drainMs` for in-flight calls, then closes. */
  close(drainMs?: number): Promise<void>;
}

/** The daemon's object graph. One place, so the CLI and the tests wire it identically. */
export interface Parts {
  guard: Guard;
  audit: AuditLog;
  pool: Pool;
  pipeline: Pipeline;
  tokens: TokenStore;
}

export function assemble(
  config: Config,
  configPath: string,
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
): Parts {
  const guard = Guard.load(config, configPath);
  const audit = new AuditLog(config.audit, guard);
  // backend_up / backend_down / drift / pinned are audited as well as logged (SPEC §7).
  const record = (event: string, fields: Record<string, unknown>) => {
    log(event, fields);
    audit.write({ method: event, ...fields });
  };
  const tokens = new TokenStore(TokenStore.pathFor(configPath));
  const authFor = (server: string) => {
    const cfg = config.servers[server];
    if (!cfg || cfg.transport === "stdio" || cfg.auth !== "oauth") return undefined;
    if (cfg.oauth_grant === "client_credentials") {
      // Machine-to-machine: the SDK fetches a token itself whenever it has none, so there is no
      // flow to run and nothing worth persisting.
      return new ClientCredentialsProvider({
        clientId: cfg.client_id!,
        clientSecret: cfg.client_secret!,
        scope: cfg.scope,
      });
    }
    return new BackendAuth(server, tokens, {
      scope: cfg.scope,
      clientId: cfg.client_id,
      clientSecret: cfg.client_secret,
      callbackPort: config.listen.oauth_callback_port,
    });
  };

  const pool = new Pool(config, record, guard, authFor);
  return { guard, audit, pool, tokens, pipeline: new Pipeline(config, pool, guard, audit) };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** JSON-RPC-shaped error, for the cases the SDK transport never sees. */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  send(res, status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tokenOk(expected: string, header: string | undefined): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Blocks DNS-rebinding from a browser tab (SPEC §10.1). */
function originOk(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The half of DNS-rebinding that `Origin` misses: browsers omit `Origin` on same-origin GETs, and
 * a rebound `evil.com:8420` page is same-origin with itself. Its `Host` still says `evil.com`.
 */
function hostOk(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLoopback(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export async function startGateway(
  config: Config,
  parts: Parts,
  opts: { port?: number; configPath?: string } = {},
): Promise<Gateway> {
  const { pool, pipeline, audit } = parts;
  const { host, token } = config.listen;

  // NFR-2. Config validation already refuses this, but the interlock belongs at bind time too:
  // it is the single thing standing between "no auth" and every backend credential on the LAN.
  if (!isLoopback(host) && !token) {
    throw new Error(`refusing to bind ${host} without listen.token (NFR-2)`);
  }

  // Buckets as the last graceful shutdown left them, beside the config they belong to.
  if (opts.configPath) pipeline.restoreLimits(dirname(opts.configPath));
  const sessions = new SessionManager(config, pipeline, audit);
  pool.onCatalogChange = () => sessions.notifyCatalogChanged();
  pool.onResourceUpdated = (server, uri) => sessions.notifyResourceUpdated(server, uri);

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) rpcError(res, 500, -32603, e.message);
      else res.end();
    });
  };
  // TLS when configured: across a LAN the token would otherwise travel in the clear.
  const tls = config.listen.tls;
  const http = tls
    ? createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, listener)
    : createServer(listener);

  /**
   * A refused token is worth a line: on a LAN listener it is somebody probing. ponytail: one line
   * per refusal, so a flood of them grows the log; rate-limit these if that ever happens.
   */
  const unauthorized = (req: IncomingMessage, res: ServerResponse, path: string) => {
    audit.write({ method: "unauthorized", path, remote: req.socket.remoteAddress });
    send(res, 401, { error: "unauthorized" });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const authorized = !token || tokenOk(token, req.headers.authorization);

    // Checked first, and for every route: a browser tab must not be able to reach any of them,
    // including the ones that answer before the token check (SPEC 10.1).
    if (!originOk(req.headers.origin)) {
      send(res, 403, { error: "forbidden origin" });
      return;
    }
    // Without a token, loopback is the only authority, so the name the request used must be
    // loopback too. With one, LAN hostnames are legitimate and the detail is token-gated anyway.
    if (!token && !hostOk(req.headers.host)) {
      send(res, 403, { error: "forbidden host" });
      return;
    }

    // The bridge probes this without a token, so an unauthorized caller still gets a liveness
    // answer — but backend names, pids and error strings are detail, and detail needs the token.
    if (path === "/healthz") {
      send(res, 200, authorized ? health() : { status: "ok" });
      return;
    }

    // The status page itself holds no data, so it needs no token; what it fetches does. The CSP
    // keeps it to its own two files and its own origin.
    if (path === "/dashboard" || path === "/dashboard.js") {
      const html = path === "/dashboard";
      res.writeHead(200, {
        "content-type": html ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(html ? DASHBOARD_HTML : DASHBOARD_JS);
      return;
    }

    // Windows has no SIGHUP to deliver, so the reload has a door on the loopback listener too.
    // It reads config.yaml from disk; nothing in the request is trusted but the fact of it.
    if (path === "/reload") {
      if (req.method !== "POST") {
        send(res, 405, { error: "POST only" });
        return;
      }
      if (!authorized) {
        unauthorized(req, res, path);
        return;
      }
      if (!opts.configPath) {
        send(res, 404, { error: "this gateway was not started from a config file" });
        return;
      }
      try {
        const { config: next } = loadConfig(opts.configPath);
        await gateway.reload(next);
        send(res, 200, { status: "reloaded", config: opts.configPath });
      } catch (e) {
        const problems = e instanceof ConfigError ? e.problems : [(e as Error).message];
        send(res, 400, { status: "unchanged", problems });
      }
      return;
    }

    // A backend that exhausted its retries, or one that has just been given OAuth tokens, needs
    // a way back up that is not "restart the daemon": `reload` deliberately skips a server whose
    // definition has not changed, so it cannot be that way back.
    if (path.startsWith("/restart/")) {
      if (req.method !== "POST") {
        send(res, 405, { error: "POST only" });
        return;
      }
      if (!authorized) {
        unauthorized(req, res, path);
        return;
      }
      const server = decodeURIComponent(path.slice("/restart/".length));
      if (!pool.backends.has(server)) {
        send(res, 404, { error: `no such server "${server}"` });
        return;
      }
      await pool.restart(server);
      const backend = pool.backends.get(server)!;
      send(res, 200, { status: backend.state, server, tools: backend.tools.length, error: backend.lastError });
      return;
    }

    if (!authorized) {
      unauthorized(req, res, path);
      return;
    }

    // What the status page shows below its backends. Read-only, and token-gated like the detail.
    if (path === "/audit/recent") {
      const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 100, 1), 1000);
      const deniedOnly = url.searchParams.get("denied") === "1";
      send(res, 200, { lines: recentLines(audit.dir, n, deniedOnly) });
      return;
    }

    const profile = path.startsWith("/mcp/") ? path.slice(5) : undefined;
    if (!profile || !sessions.hasProfile(profile)) {
      send(res, 404, { error: `unknown profile "${profile ?? ""}"` });
      return;
    }

    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        send(res, 413, { error: "request body too large" });
        return;
      }
      try {
        body = JSON.parse(raw);
      } catch {
        rpcError(res, 400, -32700, "parse error");
        return;
      }
    }

    const id = req.headers["mcp-session-id"];
    if (typeof id === "string") {
      const session = sessions.get(id);
      // A session belongs to the profile it was opened against; it may not be reused elsewhere.
      if (!session || session.profile !== profile) {
        send(res, 404, { error: "unknown session" });
        return;
      }
      sessions.track(session, res);
      await session.transport.handleRequest(req, res, body);
      return;
    }

    const initializing =
      req.method === "POST" &&
      (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body));
    if (!initializing) {
      rpcError(res, 400, -32600, "missing Mcp-Session-Id");
      return;
    }

    const transport = await sessions.create(profile);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((ok, fail) => {
    http.once("error", fail);
    http.listen(opts.port ?? config.listen.port, host, ok);
  });

  const port = (http.address() as AddressInfo).port;

  /** What `/healthz` and `mcpgw status` both report (SPEC §10.1, §11). */
  function health() {
    return {
      status: "ok",
      uptime_s: Math.round(process.uptime()),
      sessions: sessions.size,
      pending_drift: parts.guard.pending().length,
      backends: Object.fromEntries(
        [...pool.backends].map(([name, b]) => [
          name,
          { state: b.state, tools: b.tools.length, restarts: b.restarts, pid: b.pid, error: b.lastError },
        ]),
      ),
    };
  }

  const gateway: Gateway = {
    port,
    url: `${tls ? "https" : "http"}://${host}:${port}`,
    sessions,
    async reload(next: Config) {
      parts.guard.reload(next);
      parts.pipeline.reload(next);
      sessions.reload(next);
      await pool.reload(next);
      sessions.notifyCatalogChanged();
    },
    close: (drainMs = 0) => closeAll(http, sessions, parts, drainMs, opts.configPath),
  };
  return gateway;
}

async function closeAll(
  http: NetServer,
  sessions: SessionManager,
  parts: Parts,
  drainMs: number,
  configPath?: string,
): Promise<void> {
  // Stop taking new connections first, then let what is already running finish (SPEC §11).
  http.close();
  const deadline = Date.now() + drainMs;
  while (parts.pipeline.inflight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (configPath) parts.pipeline.saveLimits(dirname(configPath));

  await sessions.closeAll();
  await parts.pool.close();
  await new Promise<void>((done) => http.close(() => done()));
  await parts.audit.close();
}
