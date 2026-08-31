import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Backend } from "./backend.js";
import { GATEWAY_INFO, type Config } from "./config.js";

/** SPEC §10.1. */
const IDLE_MS = 30 * 60 * 1000;

export interface Session {
  id: string;
  profile: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
}

/**
 * Phase 1 exposes every tool of every backend. Policy filtering and renames land in Phase 3,
 * the merged catalog with truncation and collision handling in Phase 2 (`catalog.ts`).
 */
function exposedTools(backends: Map<string, Backend>): Tool[] {
  const tools: Tool[] = [];
  for (const backend of backends.values()) {
    if (backend.state !== "up") continue;
    for (const tool of backend.tools) {
      tools.push({ ...tool, name: `${backend.name}__${tool.name}` });
    }
  }
  return tools;
}

function resolve(
  backends: Map<string, Backend>,
  exposed: string,
): { backend: Backend; tool: string } {
  const split = exposed.indexOf("__");
  const backend = split > 0 ? backends.get(exposed.slice(0, split)) : undefined;
  const tool = split > 0 ? exposed.slice(split + 2) : "";
  if (!backend || !backend.tools.some((t) => t.name === tool)) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${exposed}"`);
  }
  return { backend, tool };
}

/**
 * One MCP server per session. Client request ids and backend request ids never meet: the SDK's
 * `Server` correlates each session's ids, the SDK's `Client` allocates its own per backend, and
 * a reply resolves through the promise that issued it (SPEC §4.3).
 */
function buildServer(backends: Map<string, Backend>): Server {
  const server = new Server({ ...GATEWAY_INFO }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: exposedTools(backends) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { backend, tool } = resolve(backends, request.params.name);
    return backend.callTool(tool, request.params.arguments);
  });

  return server;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly backends: Map<string, Backend>,
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
    const server = buildServer(this.backends);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        this.#sessions.set(id, { id, profile, transport, server, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.#sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
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
