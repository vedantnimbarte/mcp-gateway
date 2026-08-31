import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Backend } from "./backend.js";
import { isLoopback, type Config } from "./config.js";
import { SessionManager } from "./session.js";

/** SPEC §10.1. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface Gateway {
  port: number;
  url: string;
  sessions: SessionManager;
  close(): Promise<void>;
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
  backends: Map<string, Backend>,
  opts: { port?: number } = {},
): Promise<Gateway> {
  const { host, token } = config.listen;

  // NFR-2. Config validation already refuses this, but the interlock belongs at bind time too:
  // it is the single thing standing between "no auth" and every backend credential on the LAN.
  if (!isLoopback(host) && !token) {
    throw new Error(`refusing to bind ${host} without listen.token (NFR-2)`);
  }

  const sessions = new SessionManager(config, backends);

  const http = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) rpcError(res, 500, -32603, e.message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      const state = Object.fromEntries([...backends].map(([n, b]) => [n, b.state]));
      send(res, 200, { status: "ok", sessions: sessions.size, backends: state });
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
  return {
    port,
    url: `http://${host}:${port}`,
    sessions,
    close: () => closeAll(http, sessions, backends),
  };
}

async function closeAll(
  http: HttpServer,
  sessions: SessionManager,
  backends: Map<string, Backend>,
): Promise<void> {
  await sessions.closeAll();
  await Promise.all([...backends.values()].map((b) => b.close()));
  await new Promise<void>((done) => http.close(() => done()));
}
