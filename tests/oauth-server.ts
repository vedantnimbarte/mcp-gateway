// A minimal OAuth authorization server plus an MCP resource server that demands its tokens.
// Exists so the OAuth flow can be exercised end to end without a real provider.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface FakeProvider {
  url: string;
  mcpUrl: string;
  /** Access tokens handed out so far, newest last. */
  issued: string[];
  /** Makes every access token issued so far unusable, as expiry would. */
  expireTokens(): void;
  registrations: number;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export interface FakeOptions {
  /** Figma-shaped: advertises a registration endpoint and then refuses to use it. */
  allowRegistration?: boolean;
  /** When set, the token endpoint demands this client_secret and rejects public clients. */
  requireClient?: { id: string; secret: string };
}

export async function startFakeProvider(options: FakeOptions = {}): Promise<FakeProvider> {
  const allowRegistration = options.allowRegistration ?? true;
  const required = options.requireClient;
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const live = new Set<string>();
  const refresh = new Map<string, string>();
  const issued: string[] = [];
  let registrations = 0;

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    });
  });

  const origin = () => `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin());

    if (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: `${origin()}/mcp`, authorization_servers: [origin()] });
      return;
    }

    if (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration") {
      json(res, 200, {
        issuer: origin(),
        authorization_endpoint: `${origin()}/authorize`,
        token_endpoint: `${origin()}/token`,
        registration_endpoint: `${origin()}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: required
          ? ["client_secret_post", "client_secret_basic"]
          : ["none"],
      });
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      registrations++;
      if (!allowRegistration) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const id = `client-${randomUUID()}`;
      json(res, 201, { client_id: id, redirect_uris: [], token_endpoint_auth_method: "none" });
      return;
    }

    if (url.pathname === "/authorize") {
      const challenge = url.searchParams.get("code_challenge");
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!challenge || !redirect) {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomUUID();
      codes.set(code, { challenge, redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      if (state) back.searchParams.set("state", state);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");

      if (required) {
        const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
        const [id, secret] = basic
          ? Buffer.from(basic, "base64").toString("utf8").split(":")
          : [form.get("client_id"), form.get("client_secret")];
        if (id !== required.id || secret !== required.secret) {
          json(res, 401, { error: "invalid_client" });
          return;
        }
      }

      if (grant === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (!refresh.has(token)) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        json(res, 200, issue(token));
        return;
      }

      const record = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!record) {
        json(res, 400, { error: "invalid_grant" });
        return;
      }
      // PKCE is the point of the exercise; a wrong verifier must not be accepted.
      if (s256(verifier) !== record.challenge) {
        json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        return;
      }
      codes.delete(form.get("code") ?? "");
      json(res, 200, issue());
      return;
    }

    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!live.has(bearer)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin()}/.well-known/oauth-protected-resource"`,
        });
        res.end();
        return;
      }
      await serveMcp(req, res);
      return;
    }

    json(res, 404, { error: "not_found" });
  }

  function issue(existingRefresh?: string) {
    const access = `access-${randomUUID()}`;
    const refreshToken = existingRefresh ?? `refresh-${randomUUID()}`;
    live.add(access);
    issued.push(access);
    refresh.set(refreshToken, access);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }

  /** One MCP server per session, the way a real server does it. */
  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? sessions.get(id) : undefined;

    if (!transport) {
      const server = new McpServer({ name: "protected", version: "1.0.0" });
      server.registerTool(
        "secret",
        { description: "Only reachable with a token.", inputSchema: { of: z.string() } },
        ({ of }) => ({ content: [{ type: "text", text: `secret of ${of}` }] }),
      );
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport!);
        },
      });
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));

  return {
    url: origin(),
    mcpUrl: `${origin()}/mcp`,
    issued,
    expireTokens: () => live.clear(),
    get registrations() {
      return registrations;
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close()));
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
