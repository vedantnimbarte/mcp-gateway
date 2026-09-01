import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AuditLog } from "./audit.js";
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
    return new BackendAuth(server, tokens, {
      scope: cfg.scope,
      clientId: cfg.client_id,
      clientSecret: cfg.client_secret,
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

  const sessions = new SessionManager(config, pipeline, audit);
  pool.onCatalogChange = () => sessions.notifyCatalogChanged();

  const http = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) rpcError(res, 500, -32603, e.message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      send(res, 200, health());
      return;
    }

    // Windows has no SIGHUP to deliver, so the reload has a door on the loopback listener too.
    // It reads config.yaml from disk; nothing in the request is trusted but the fact of it.
    if (path === "/reload") {
      if (req.method !== "POST") {
        send(res, 405, { error: "POST only" });
        return;
      }
      if (token && !tokenOk(token, req.headers.authorization)) {
        send(res, 401, { error: "unauthorized" });
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

    if (token && !tokenOk(token, req.headers.authorization)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (!originOk(req.headers.origin)) {
      send(res, 403, { error: "forbidden origin" });
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
    url: `http://${host}:${port}`,
    sessions,
    async reload(next: Config) {
      parts.guard.reload(next);
      parts.pipeline.reload(next);
      sessions.reload(next);
      await pool.reload(next);
      sessions.notifyCatalogChanged();
    },
    close: (drainMs = 0) => closeAll(http, sessions, parts, drainMs),
  };
  return gateway;
}

async function closeAll(
  http: HttpServer,
  sessions: SessionManager,
  parts: Parts,
  drainMs: number,
): Promise<void> {
  // Stop taking new connections first, then let what is already running finish (SPEC §11).
  http.close();
  const deadline = Date.now() + drainMs;
  while (parts.pipeline.inflight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  await sessions.closeAll();
  await parts.pool.close();
  await new Promise<void>((done) => http.close(() => done()));
  await parts.audit.close();
}
