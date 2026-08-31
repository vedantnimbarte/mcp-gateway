import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  ListRootsRequest,
  ListRootsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_INFO, type Config, type ServerConfig } from "./config.js";
import { ERR, gwError } from "./errors.js";

export type BackendState = "connecting" | "up" | "down";

/** SPEC §1.2: backoff doubles per attempt, capped. */
const MAX_BACKOFF_MS = 30_000;

/**
 * What a backend can ask of the client that called it (ARCHITECTURE §3.2). An SDK `Server` —
 * i.e. one session — satisfies this structurally.
 */
export interface ReverseTarget {
  createMessage(params: CreateMessageRequest["params"], options?: RequestOptions): Promise<unknown>;
  elicitInput(params: ElicitRequest["params"], options?: RequestOptions): Promise<unknown>;
  listRoots(params?: ListRootsRequest["params"], options?: RequestOptions): Promise<unknown>;
}

function makeTransport(cfg: ServerConfig): Transport {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      // Merged, not replaced: without PATH (and on Windows, the rest) `npx` cannot be found.
      env: { ...getDefaultEnvironment(), ...cfg.env },
      cwd: cfg.cwd,
      stderr: "inherit",
    });
  }
  const url = new URL(cfg.url);
  const opts = { requestInit: { headers: cfg.headers } };
  return cfg.transport === "http"
    ? new StreamableHTTPClientTransport(url, opts)
    : new SSEClientTransport(url, opts);
}

/**
 * One backend server: its connection, its tools, its supervision. Shared by every session
 * (ARCHITECTURE §1) — a crash here must never reach the daemon or its peers (NFR-5).
 */
export class Backend {
  state: BackendState = "connecting";
  tools: Tool[] = [];
  lastError?: string;
  restarts = 0;
  /** Called whenever this backend's contribution to the catalog changes. */
  onChange?: (backend: Backend) => void;
  /** Structured log sink; the pool wires it to stderr. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void;

  #client?: Client;
  #transport?: StdioClientTransport;
  #inflight = new Set<ReverseTarget>();
  #attempt = 0;
  #retry?: NodeJS.Timeout;
  #closing = false;

  constructor(
    readonly name: string,
    readonly config: ServerConfig,
    private readonly defaults: Config["defaults"],
  ) {}

  /** The child process, when this backend is stdio and running. */
  get pid(): number | null {
    return this.#transport?.pid ?? null;
  }

  async start(): Promise<void> {
    this.state = "connecting";
    const transport = makeTransport(this.config);
    const client = new Client(
      { ...GATEWAY_INFO },
      // Advertised optimistically: whether the calling session can actually service one is
      // discovered when a reverse request arrives (ARCHITECTURE §3.2).
      { capabilities: { sampling: {}, elicitation: {}, roots: {} } },
    );

    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const target = this.#route("sampling/createMessage");
      return (await target.createMessage(request.params)) as CreateMessageResult;
    });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const target = this.#route("elicitation/create");
      return (await target.elicitInput(request.params)) as ElicitResult;
    });
    client.setRequestHandler(ListRootsRequestSchema, async (request) => {
      const target = this.#route("roots/list");
      return (await target.listRoots(request.params)) as ListRootsResult;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.#relist();
    });

    try {
      await client.connect(transport, { timeout: this.defaults.connect_timeout_ms });
    } catch (e) {
      await client.close().catch(() => {});
      this.#failAndRetry((e as Error).message);
      throw e;
    }

    this.#client = client;
    this.#transport = transport instanceof StdioClientTransport ? transport : undefined;
    client.onclose = () => this.#disconnected("connection closed");

    try {
      this.tools = await this.refreshTools();
    } catch (e) {
      await client.close().catch(() => {});
      this.#failAndRetry((e as Error).message);
      throw e;
    }

    if (this.#attempt > 0) this.restarts++;
    this.#attempt = 0;
    this.state = "up";
    this.lastError = undefined;
    this.onEvent?.("backend_up", { server: this.name, tools: this.tools.length, pid: this.pid });
    this.onChange?.(this);
  }

  /** Pagination is collapsed here — the gateway serves one merged page (SPEC §4.1). */
  async refreshTools(): Promise<Tool[]> {
    const client = this.#client;
    if (!client || !client.getServerCapabilities()?.tools) return [];

    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: this.defaults.call_timeout_ms,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(
    tool: string,
    args: Record<string, unknown> | undefined,
    caller?: ReverseTarget,
  ): Promise<CallToolResult> {
    const client = this.#client;
    if (!client || this.state !== "up") {
      throw gwError(ERR.BACKEND_DOWN, `backend "${this.name}" is ${this.state}`, {
        reason: "server_unavailable",
        server: this.name,
        tool,
      });
    }
    if (caller) this.#inflight.add(caller);
    try {
      return (await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
        timeout: this.defaults.call_timeout_ms,
      })) as CallToolResult;
    } catch (e) {
      throw this.#wrap(e, tool);
    } finally {
      if (caller) this.#inflight.delete(caller);
    }
  }

  /**
   * Routes a backend→client request to the session that owns the call it arrived during.
   *
   * ponytail: single-outstanding-call routing only. `_meta.relatedRequestId` would be exact,
   * but the SDK does not expose the request id it allocated, so the correlation cannot be made
   * without reimplementing its dispatch. Concurrent calls on one backend therefore get -32006
   * rather than a guess — the failure is visible, and guessing would leak one client's prompt
   * to another. Upgrade: own the JSON-RPC ids, or use an SDK that surfaces them.
   */
  #route(method: string): ReverseTarget {
    if (this.#inflight.size !== 1) {
      this.onEvent?.("unroutable", { server: this.name, method, inflight: this.#inflight.size });
      throw gwError(ERR.UNROUTABLE, `cannot route ${method} from "${this.name}" to a session`, {
        reason: "unroutable",
        server: this.name,
      });
    }
    return [...this.#inflight][0]!;
  }

  async #relist(): Promise<void> {
    if (this.state !== "up") return;
    try {
      this.tools = await this.refreshTools();
      this.onChange?.(this);
    } catch (e) {
      this.onEvent?.("relist_failed", { server: this.name, error: (e as Error).message });
    }
  }

  /** Backend failures are wrapped with the gateway's own code; the original travels in `data`. */
  #wrap(e: unknown, tool: string): Error {
    if (!(e instanceof McpError)) return e as Error;
    const context = { server: this.name, tool, upstream: { code: e.code, message: e.message } };

    if (e.code === ErrorCode.RequestTimeout) {
      return gwError(ERR.TIMEOUT, `${this.name}__${tool} timed out`, { reason: "timeout", ...context });
    }
    if (e.code === ErrorCode.ConnectionClosed) {
      return gwError(ERR.BACKEND_DOWN, `backend "${this.name}" closed the connection`, {
        reason: "server_unavailable",
        ...context,
      });
    }
    return e;
  }

  /**
   * The connection dropped on its own. In-flight calls are already rejected by the SDK with
   * ConnectionClosed, which `#wrap` turns into -32003.
   */
  #disconnected(reason: string): void {
    if (this.#closing || this.state === "down") return;
    this.#failAndRetry(reason);
    this.onChange?.(this);
  }

  /** Every failure path retries: a slow `npx` cold start is indistinguishable from a crash. */
  #failAndRetry(reason: string): void {
    this.#fail(reason);
    this.#scheduleRestart();
  }

  #fail(reason: string): void {
    this.state = "down";
    this.lastError = reason;
    this.tools = [];
    this.#client = undefined;
    this.#transport = undefined;
    this.#inflight.clear();
    this.onEvent?.("backend_down", { server: this.name, error: reason });
  }

  #scheduleRestart(): void {
    if (this.#closing || this.#retry) return;
    const { max_retries, backoff_ms } = this.config.restart;
    if (this.#attempt >= max_retries) {
      this.onEvent?.("backend_exhausted", { server: this.name, attempts: this.#attempt });
      return;
    }
    const delay = Math.min(backoff_ms * 2 ** this.#attempt, MAX_BACKOFF_MS);
    this.#attempt++;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.start().catch(() => {});
    }, delay);
    this.#retry.unref();
    this.onEvent?.("backend_retry", { server: this.name, attempt: this.#attempt, in_ms: delay });
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#retry);
    this.state = "down";
    this.tools = [];
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    await client?.close().catch(() => {});
  }
}
