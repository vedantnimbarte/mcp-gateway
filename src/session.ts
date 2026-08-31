import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLog } from "./audit.js";
import { GATEWAY_INFO, type Config } from "./config.js";
import type { Pipeline } from "./pipeline.js";

/** SPEC §10.1. */
const IDLE_MS = 30 * 60 * 1000;

export interface Session {
  id: string;
  profile: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
  /** The tool names last shown to this client, to suppress no-op list_changed notifications. */
  visible: string;
}

/**
 * One MCP server per session. Client request ids and backend request ids never meet: the SDK's
 * `Server` correlates each session's ids, the SDK's `Client` allocates its own per backend, and
 * a reply resolves through the promise that issued it (SPEC §4.3).
 */
function buildServer(pipeline: Pipeline, profile: string, sessionId: () => string | undefined): Server {
  const server = new Server({ ...GATEWAY_INFO }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: pipeline.visibleTools(profile),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    pipeline.callTool(
      {
        profile,
        session: sessionId(),
        client: server.getClientVersion(),
        // `server` is this session: what a reverse request from the backend routes back to.
        caller: server,
      },
      request.params.name,
      request.params.arguments,
    ),
  );

  return server;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly pipeline: Pipeline,
    private readonly audit: AuditLog,
  ) {
    this.#sweeper = setInterval(() => this.#sweep(), 60_000);
    this.#sweeper.unref();
  }

  get size(): number {
    return this.#sessions.size;
  }

  get(id: string): Session | undefined {
    const session = this.#sessions.get(id);
    if (session) session.lastSeen = Date.now();
    return session;
  }

  hasProfile(profile: string): boolean {
    return profile in this.config.profiles;
  }

  /**
   * Builds a session transport. The id only exists once the client's `initialize` has been
   * handled, so registration happens in the transport's own callback.
   */
  async create(profile: string): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        this.#sessions.set(id, {
          id,
          profile,
          transport,
          server,
          lastSeen: Date.now(),
          visible: this.#visible(profile),
        });
      },
      onsessionclosed: (id) => this.#forget(id),
    });
    const server = buildServer(this.pipeline, profile, () => transport.sessionId);
    // Fires after the handshake, which is when the client has actually named itself.
    server.oninitialized = () => {
      this.audit.write({
        method: "initialize",
        session: transport.sessionId,
        profile,
        client: server.getClientVersion(),
      });
    };
    transport.onclose = () => {
      if (transport.sessionId) this.#forget(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }

  /**
   * Wakes only the sessions whose own view actually changed — a chatty backend must not spam
   * every client (ARCHITECTURE §3.3).
   */
  notifyCatalogChanged(): void {
    for (const session of this.#sessions.values()) {
      const visible = this.#visible(session.profile);
      if (visible === session.visible) continue;
      session.visible = visible;
      session.server.sendToolListChanged().catch(() => {});
    }
  }

  #forget(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    this.audit.write({ method: "session_close", session: id, profile: session.profile });
  }

  #visible(profile: string): string {
    return this.pipeline.visibleFingerprint(profile);
  }

  #sweep(): void {
    const deadline = Date.now() - IDLE_MS;
    for (const session of [...this.#sessions.values()]) {
      if (session.lastSeen < deadline) void session.transport.close();
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.#sweeper);
    await Promise.all([...this.#sessions.values()].map((s) => s.transport.close()));
    this.#sessions.clear();
  }
}
