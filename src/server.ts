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
import { ConfigError, GATEWAY_INFO, isLoopback, loadConfig, parseConfig, type Config } from "./config.js";
import { auditStats, WINDOWS, type Window } from "./stats.js";
import {
  ConflictError,
  LayoutError,
  readConfigText,
  saveConfigText,
  setServerDisabled,
  setToolDenied,
} from "./configfile.js";
import { globMatch } from "./glob.js";
import { canonicalJson, Guard } from "./guard.js";
import { serverOf } from "./policy.js";
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
  const authFor = (server: string, current: Config) => {
    const cfg = current.servers[server];
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
      callbackPort: current.listen.oauth_callback_port,
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

/** The named client whose token this is, if any. Every key is compared, so timing says nothing. */
function clientKey(clients: Config["listen"]["clients"], header: string | undefined) {
  let found: Config["listen"]["clients"][number] | undefined;
  for (const client of clients) if (tokenOk(client.token, header)) found = client;
  return found;
}

/**
 * Blocks DNS-rebinding from a browser tab (SPEC §10.1). `self` is the request's own `Host`, passed
 * only when a token is set: the status page served over a LAN name POSTs with that name as its
 * Origin. A rebound page can match it too, but it holds no token, and everything that acts needs one.
 */
function originOk(origin: string | undefined, self?: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return isLoopback(url.hostname) || url.host === self;
  } catch {
    return false;
  }
}

/**
 * The config editor's boundary, on top of the token: writing `command:` runs a program as whoever
 * runs the daemon, so a token stolen on the LAN must not be enough. ponytail: a reverse proxy on
 * this machine makes every request look local; the editor would then answer the LAN behind it.
 */
export function fromThisMachine(req: Pick<IncomingMessage, "socket">): boolean {
  return isLoopback((req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""));
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
  /** `onStop` is what `POST /stop` asks for; the CLI drains and exits, which a library must not. */
  opts: { port?: number; configPath?: string; onStop?: () => void } = {},
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
  /** Who reloaded, restarted, stopped or reconfigured the gateway, and whether it worked. */
  const manage = (req: IncomingMessage, action: string, status: "ok" | "error", fields = {}) =>
    audit.write({ method: "manage", action, status, remote: req.socket.remoteAddress, ...fields });

  /** The config the daemon is running, which after a reload is no longer the one it started with. */
  let current = config;
  let changing: Promise<unknown> = Promise.resolve();
  /** One config change at a time: two overlapping reloads would each diff against a half-applied pool. */
  const serially = (fn: () => Promise<void>): Promise<void> => {
    const run = changing.then(fn, fn);
    changing = run.catch(() => {});
    return run;
  };

  /** Writes config.yaml through `write`, then reloads what it wrote. A refused edit changes nothing. */
  async function saveAndReload(
    req: IncomingMessage,
    res: ServerResponse,
    action: string,
    fields: Record<string, string>,
    write: (file: string) => Config,
  ): Promise<void> {
    const file = opts.configPath;
    if (!file) {
      send(res, 404, { error: "this gateway was not started from a config file" });
      return;
    }
    await serially(async () => {
      let next: Config;
      try {
        next = write(file);
      } catch (e) {
        const known = e instanceof ConfigError || e instanceof LayoutError || e instanceof ConflictError;
        if (!known) throw e;
        const problems = e instanceof ConfigError ? e.problems : [e.message];
        manage(req, action, "error", { ...fields, problems });
        // 409 when the edit was fine but the file is the obstacle: a layout the splice will not
        // touch, or a change on disk the editor never saw.
        send(res, e instanceof ConfigError ? 400 : 409, { status: "unchanged", problems });
        return;
      }
      const restartNeeded = listenChanged(next);
      await gateway.reload(next);
      manage(req, action, "ok", fields);
      send(res, 200, { status: "saved", ...fields, hash: readConfigText(file).hash, restart_needed: restartNeeded });
    });
  }

  /**
   * The port is bound once: a changed `listen` block is saved, but only a daemon restart applies it.
   * Client keys are the exception: they are read on every request, so a reload applies them.
   */
  const listenChanged = (next: Config) => {
    const bound = (c: Config) => canonicalJson({ ...c.listen, clients: undefined });
    return bound(next) !== bound(current);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const authorized = !token || tokenOk(token, req.headers.authorization);

    // Checked first, and for every route: a browser tab must not be able to reach any of them,
    // including the ones that answer before the token check (SPEC 10.1).
    if (!originOk(req.headers.origin, token ? req.headers.host : undefined)) {
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
      send(res, 200, authorized ? health(fromThisMachine(req)) : { status: "ok" });
      return;
    }

    // The status page lives at the root; its old address still finds it.
    if (path === "/dashboard") {
      res.writeHead(308, { location: "/" });
      res.end();
      return;
    }

    // The status page itself holds no data, so it needs no token; what it fetches does. The CSP
    // keeps it to its own two files and its own origin.
    if (path === "/" || path === "/dashboard.js") {
      const html = path === "/";
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
      const configPath = opts.configPath;
      await serially(async () => {
        try {
          const { config: next } = loadConfig(configPath);
          await gateway.reload(next);
          manage(req, "reload", "ok");
          send(res, 200, { status: "reloaded", config: configPath });
        } catch (e) {
          const problems = e instanceof ConfigError ? e.problems : [(e as Error).message];
          manage(req, "reload", "error", { problems });
          send(res, 400, { status: "unchanged", problems });
        }
      });
      return;
    }

    /**
     * The status page's management routes. Beyond reload and restart they need a token set at all:
     * with none, loopback reachability would be the only thing between any local process and
     * stopping or rewriting the gateway. Answers the refusal itself and returns false.
     */
    const gated = (method: "GET" | "POST" | "PUT"): boolean => {
      if (req.method !== method) {
        send(res, 405, { error: `${method} only` });
      } else if (!token) {
        send(res, 403, { error: "management requires listen.token" });
      } else if (!authorized) {
        unauthorized(req, res, path);
      } else {
        return true;
      }
      return false;
    };

    if (path === "/stop") {
      if (!gated("POST")) return;
      if (!opts.onStop) {
        send(res, 404, { error: "this gateway cannot be stopped over HTTP" });
        return;
      }
      manage(req, "stop", "ok");
      // Answer before draining: the listener stops accepting as the drain begins.
      res.once("finish", opts.onStop);
      send(res, 202, { status: "stopping" });
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
      manage(req, "restart", backend.state === "up" ? "ok" : "error", { server });
      send(res, 200, { status: backend.state, server, tools: backend.tools.length, error: backend.lastError });
      return;
    }

    // Switching a server off or on is `disabled: true|false` in config.yaml, then a reload: the
    // file stays the one source of truth, so the next reload or restart cannot quietly undo it.
    const serverToggle = /^\/servers\/([^/]+)\/(disable|enable)$/.exec(path);
    if (serverToggle) {
      if (!gated("POST")) return;
      const server = decodeURIComponent(serverToggle[1]!);
      if (!(server in current.servers) && !current.disabled?.includes(server)) {
        send(res, 404, { error: `no such server "${server}"` });
        return;
      }
      const disabled = serverToggle[2] === "disable";
      await saveAndReload(req, res, `${serverToggle[2]}_server`, { server }, (file) =>
        setServerDisabled(file, server, disabled),
      );
      return;
    }

    // What `mcpgw list` prints for one profile, plus which tools the page can switch: an exact
    // deny entry can be removed, and a tool no deny glob covers can be given one. Globs and allow
    // lists are left to the YAML. Reading it is detail like /healthz's, so it needs only what
    // detail needs; the switches themselves are the gated routes below.
    const toolList = /^\/profiles\/([^/]+)\/tools$/.exec(path);
    if (toolList) {
      if (req.method !== "GET") {
        send(res, 405, { error: "GET only" });
        return;
      }
      if (!authorized) {
        unauthorized(req, res, path);
        return;
      }
      const name = decodeURIComponent(toolList[1]!);
      const profile = current.profiles[name];
      if (!profile) {
        send(res, 404, { error: `unknown profile "${name}"` });
        return;
      }
      const tools = pipeline.explain(name).map(({ entry, exposed, decision }) => {
        const exact = profile.deny.includes(entry.canonical);
        const globbed = profile.deny.some((g) => g !== entry.canonical && globMatch(g, entry.canonical));
        const notAllowed = !decision.allow && decision.reason === "not_allowed";
        const toggle = globbed ? null : exact ? "enable" : notAllowed ? null : "disable";
        return {
          tool: exposed,
          canonical: entry.canonical,
          allow: decision.allow,
          reason: decision.allow ? undefined : decision.reason,
          rule: decision.rule,
          toggle,
        };
      });
      tools.sort((a, b) => a.tool.localeCompare(b.tool));
      send(res, 200, { profile: name, tools });
      return;
    }

    const toolToggle = /^\/profiles\/([^/]+)\/tools\/([^/]+)\/(disable|enable)$/.exec(path);
    if (toolToggle) {
      if (!gated("POST")) return;
      const profile = decodeURIComponent(toolToggle[1]!);
      const tool = decodeURIComponent(toolToggle[2]!);
      if (!(profile in current.profiles)) {
        send(res, 404, { error: `unknown profile "${profile}"` });
        return;
      }
      if (!serverOf(tool)) {
        send(res, 400, { error: `"${tool}" is not a canonical <server>__<tool> name` });
        return;
      }
      const denied = toolToggle[3] === "disable";
      await saveAndReload(req, res, `${toolToggle[3]}_tool`, { profile, tool }, (file) =>
        setToolDenied(file, profile, tool, denied),
      );
      return;
    }

    // A person's answer to a call waiting for approval. Gated like stop: without a token, any
    // local process could POST here, a model's own fetch tool included, and approve itself.
    const approval = /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
    if (approval) {
      if (!gated("POST")) return;
      const yes = approval[2] === "approve";
      const id = decodeURIComponent(approval[1]!);
      const waiting = pipeline.approvals.list().find((p) => p.id === id);
      if (!pipeline.approvals.decide(id, yes)) {
        send(res, 404, { error: "that call is no longer waiting: answered, timed out or cancelled" });
        return;
      }
      manage(req, yes ? "approve_call" : "deny_call", "ok", {
        profile: waiting?.profile,
        tool: waiting?.canonical,
      });
      send(res, 200, { status: yes ? "approved" : "denied" });
      return;
    }

    // The raw YAML editor: the file as written, a dry run, and a save guarded by the hash the
    // editor loaded. Loopback only, on top of the token (see fromThisMachine).
    if (path === "/config" || path === "/config/validate") {
      const validate = path === "/config/validate";
      if (!gated(validate ? "POST" : req.method === "PUT" ? "PUT" : "GET")) return;
      if (!fromThisMachine(req)) {
        send(res, 403, { error: "the config editor answers requests from this machine only" });
        return;
      }
      const file = opts.configPath;
      if (!file) {
        send(res, 404, { error: "this gateway was not started from a config file" });
        return;
      }
      if (req.method === "GET") {
        send(res, 200, { path: file, ...readConfigText(file) });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        send(res, 413, { error: "request body too large" });
        return;
      }
      let body: { text?: unknown; base_hash?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        send(res, 400, { error: "body must be JSON" });
        return;
      }
      const { text, base_hash: baseHash } = body;
      if (typeof text !== "string" || (!validate && typeof baseHash !== "string")) {
        send(res, 400, { error: validate ? "expected { text }" : "expected { text, base_hash }" });
        return;
      }
      if (validate) {
        try {
          const next = parseConfig(text, file);
          send(res, 200, { status: "valid", restart_needed: listenChanged(next) });
        } catch (e) {
          if (!(e instanceof ConfigError)) throw e;
          send(res, 400, { status: "invalid", problems: e.problems });
        }
        return;
      }
      await saveAndReload(req, res, "edit_config", {}, (f) => saveConfigText(f, text, baseHash as string));
      return;
    }

    // A client token opens its own profiles' MCP routes and nothing else, so the general check
    // waits for the MCP route to apply its own.
    const mcp = path.startsWith("/mcp/");
    if (!authorized && !mcp) {
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

    // Calls waiting for a person. Seeing them is detail; answering is the gated route above.
    if (path === "/approvals") {
      send(res, 200, { approvals: pipeline.approvals.list(), can_answer: Boolean(token) });
      return;
    }

    // The status page's charts: the same audit log, counted over a window.
    if (path === "/audit/stats") {
      const window = url.searchParams.get("window") ?? "24h";
      if (!(window in WINDOWS)) {
        send(res, 400, { error: `window must be one of ${Object.keys(WINDOWS).join(", ")}` });
        return;
      }
      await audit.flush();
      send(res, 200, auditStats(audit.dir, window as Window));
      return;
    }

    const profile = mcp ? path.slice(5) : undefined;
    if (!profile || !sessions.hasProfile(profile)) {
      send(res, 404, { error: `unknown profile "${profile ?? ""}"` });
      return;
    }

    // Who is calling: a named client key, limited to its profiles, or the gateway token (or, with
    // no tokens configured at all, loopback alone), which reaches every profile.
    const key = clientKey(current.listen.clients, req.headers.authorization);
    if (key) {
      if (!key.profiles.includes("*") && !key.profiles.includes(profile)) {
        audit.write({ method: "forbidden", path, client_key: key.name, remote: req.socket.remoteAddress });
        send(res, 403, { error: `client "${key.name}" may not use profile "${profile}"` });
        return;
      }
    } else if (token ? !authorized : current.listen.clients.length > 0) {
      unauthorized(req, res, path);
      return;
    }
    const keyName = key?.name;

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
      // A session belongs to the profile and the key it was opened with; it may not be reused
      // elsewhere, nor carried on by a caller holding a different key.
      if (!session || session.profile !== profile || session.clientKey !== keyName) {
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

    const transport = await sessions.create(profile, keyName);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((ok, fail) => {
    http.once("error", fail);
    http.listen(opts.port ?? config.listen.port, host, ok);
  });

  const port = (http.address() as AddressInfo).port;

  /** What `/healthz` and `mcpgw status` both report (SPEC §10.1, §11). `local`: asked from this machine. */
  function health(local: boolean) {
    return {
      status: "ok",
      // Whether the status page may offer its buttons: management needs a token set.
      manage: Boolean(token),
      // The config editor also needs the request to come from this machine.
      editor: Boolean(token) && local,
      uptime_s: Math.round(process.uptime()),
      version: GATEWAY_INFO.version,
      node: process.version,
      pid: process.pid,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      listen: `${tls ? "https" : "http"}://${host}:${port}`,
      sessions: sessions.size,
      pending_drift: parts.guard.pending().length,
      pending_approvals: pipeline.approvals.list().length,
      profiles: Object.keys(current.profiles),
      // What each profile exposes and to how many clients: the right-hand side of the diagram.
      profile_detail: Object.fromEntries(
        Object.entries(current.profiles).map(([name, p]) => [
          name,
          {
            servers: p.servers,
            tools: parts.pipeline.visibleTools(name).length,
            sessions: sessions.countFor(name),
            context: p.context.tools === "lazy" || p.context.handle_bytes !== undefined || p.context.code
              ? p.context
              : undefined,
          },
        ]),
      ),
      disabled: current.disabled ?? [],
      // Names and reach only; the tokens themselves never leave the config.
      clients: current.listen.clients.map((c) => ({ name: c.name, profiles: c.profiles })),
      backends: Object.fromEntries(
        [...pool.backends].map(([name, b]) => [
          name,
          {
            state: b.state,
            transport: current.servers[name]?.transport,
            tools: b.tools.length,
            restarts: b.restarts,
            pid: b.pid,
            error: b.lastError,
          },
        ]),
      ),
    };
  }

  const gateway: Gateway = {
    port,
    url: `${tls ? "https" : "http"}://${host}:${port}`,
    sessions,
    async reload(next: Config) {
      current = next;
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
