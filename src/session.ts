import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLog } from "./audit.js";
import { namespaceUri } from "./catalog.js";
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
  /** What was last shown to this client, to suppress no-op list_changed notifications. */
  visible: { tools: string; prompts: string; resources: string };
}

/**
 * One MCP server per session. Client request ids and backend request ids never meet: the SDK's
 * `Server` correlates each session's ids, the SDK's `Client` allocates its own per backend, and
 * a reply resolves through the promise that issued it (SPEC §4.3).
 */
function buildServer(pipeline: Pipeline, profile: string, sessionId: () => string | undefined): Server {
  const server = new Server(
    { ...GATEWAY_INFO },
    {
      // Advertised whether or not a backend currently offers them: sessions outlive backends,
      // and a profile with no resources simply lists none (ARCHITECTURE 4.1).
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        completions: {},
      },
    },
  );

  // `server` is this session: what a reverse request from the backend routes back to.
  const ctx = () => ({
    profile,
    session: sessionId(),
    client: server.getClientVersion(),
    caller: server,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: pipeline.visibleTools(profile),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    pipeline.callTool(ctx(), request.params.name, request.params.arguments),
  );

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: pipeline.visiblePrompts(profile),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    pipeline.getPrompt(ctx(), request.params.name, request.params.arguments),
  );

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: pipeline.visibleResources(profile),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: pipeline.visibleTemplates(profile),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    pipeline.readResource(ctx(), request.params.uri),
  );

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    await pipeline.subscribe(ctx(), request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    await pipeline.unsubscribe(ctx(), request.params.uri);
    return {};
  });

  server.setRequestHandler(CompleteRequestSchema, (request) =>
    pipeline.complete(ctx(), request.params),
  );

  return server;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(
    private config: Config,
    readonly pipeline: Pipeline,
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

  /** After a SIGHUP, live sessions keep their profile name; what it means may have changed. */
  reload(config: Config): void {
    this.config = config;
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
      const now = this.#visible(session.profile);
      const was = session.visible;
      session.visible = now;

      if (now.tools !== was.tools) session.server.sendToolListChanged().catch(() => {});
      if (now.prompts !== was.prompts) session.server.sendPromptListChanged().catch(() => {});
      if (now.resources !== was.resources) session.server.sendResourceListChanged().catch(() => {});
    }
  }

  /**
   * A backend says a resource changed; only the sessions that asked about it hear so
   * (ARCHITECTURE 3.3).
   */
  notifyResourceUpdated(server: string, uri: string): void {
    const namespaced = namespaceUri(server, uri);
    for (const sessionId of this.pipeline.watchersOf(namespaced)) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      session.server
        .notification({ method: "notifications/resources/updated", params: { uri: namespaced } })
        .catch(() => {});
    }
  }

  #forget(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    // Releases any backend subscriptions this session was the last one holding.
    this.pipeline.dropSession(id, { profile: session.profile, session: id });
    this.audit.write({ method: "session_close", session: id, profile: session.profile });
  }

  #visible(profile: string): Session["visible"] {
    return {
      tools: this.pipeline.visibleFingerprint(profile),
      prompts: this.pipeline.promptFingerprint(profile),
      resources: this.pipeline.resourceFingerprint(profile),
    };
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
