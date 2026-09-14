import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
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
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CompleteRequest,
  LoggingMessageNotification,
  CompleteResult,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  GetPromptResult,
  ListRootsRequest,
  ListRootsResult,
  Progress,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_INFO, type Config, type ServerConfig } from "./config.js";
import { ERR, gwError } from "./errors.js";
import { NeedsAuthorization } from "./oauth.js";

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
  /** Backend log output, already filtered by the session's own level. */
  log(params: LoggingMessageNotification["params"]): void;
}

/** Who a request is on behalf of: where reverse requests and progress go, and its abort. */
export interface Caller {
  caller?: ReverseTarget;
  signal?: AbortSignal;
  /** Set only when the client asked for progress by sending a token. */
  onprogress?: (progress: Progress) => void;
}

function makeTransport(cfg: ServerConfig, authProvider?: OAuthClientProvider): Transport {
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
  const opts = { requestInit: { headers: cfg.headers }, authProvider };
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
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  /** Called when this backend reports that one of its resources changed. */
  onResourceUpdated?: (server: string, uri: string) => void;
  lastError?: string;
  restarts = 0;
  /** Called whenever this backend's contribution to the catalog changes. */
  onChange?: (backend: Backend) => void;
  /** Structured log sink; the pool wires it to stderr. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void;

  #client?: Client;
  #transport?: StdioClientTransport;
  /** Sessions with work outstanding here, counted: one session may have several calls running. */
  #inflight = new Map<ReverseTarget, number>();
  #attempt = 0;
  #retry?: NodeJS.Timeout;
  #closing = false;

  /** Set when the backend cannot come up without someone completing an OAuth flow. */
  needsAuth = false;

  constructor(
    readonly name: string,
    readonly config: ServerConfig,
    private readonly defaults: Config["defaults"],
    private readonly authProvider?: OAuthClientProvider,
  ) {}

  /** The child process, when this backend is stdio and running. */
  get pid(): number | null {
    return this.#transport?.pid ?? null;
  }

  async start(): Promise<void> {
    this.state = "connecting";
    const transport = makeTransport(this.config, this.authProvider);
    const client = new Client(
      { ...GATEWAY_INFO },
      // Advertised optimistically: whether the calling session can actually service one is
      // discovered when a reverse request arrives (ARCHITECTURE §3.2).
      { capabilities: { sampling: {}, elicitation: {}, roots: {} } },
    );

    // The backend's cancel reaches the client, and the wait is bounded like the call it serves.
    const reverse = (signal: AbortSignal): RequestOptions => ({
      signal,
      timeout: this.defaults.call_timeout_ms,
    });
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
      const target = this.#route("sampling/createMessage");
      const reply = await target.createMessage(request.params, reverse(extra.signal));
      return reply as CreateMessageResult;
    });
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const target = this.#route("elicitation/create");
      return (await target.elicitInput(request.params, reverse(extra.signal))) as ElicitResult;
    });
    client.setRequestHandler(ListRootsRequestSchema, async (request, extra) => {
      const target = this.#route("roots/list");
      return (await target.listRoots(request.params, reverse(extra.signal))) as ListRootsResult;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.#relist();
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      void this.#relist();
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      void this.#relist();
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      this.onResourceUpdated?.(this.name, notification.params.uri);
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      // A notification cannot be answered with an error, so an unroutable one is simply
      // dropped rather than broadcast — the same rule as reverse requests, minus the -32006.
      const target = this.#inflight.size === 1 ? [...this.#inflight.keys()][0] : undefined;
      if (target) target.log({ ...notification.params, logger: notification.params.logger ?? this.name });
      else this.onEvent?.("log_dropped", { server: this.name, level: notification.params.level });
    });

    try {
      await client.connect(transport, { timeout: this.defaults.connect_timeout_ms });
    } catch (e) {
      // A slow `npx` that timed out has usually already started its grandchild.
      await closeTree(client, transport instanceof StdioClientTransport ? transport.pid : null);
      this.#failAndRetry(e);
      throw e;
    }

    this.#client = client;
    this.#transport = transport instanceof StdioClientTransport ? transport : undefined;
    client.onclose = () => this.#disconnected("connection closed");

    try {
      await this.refresh();
    } catch (e) {
      await closeTree(client, this.pid);
      this.#failAndRetry(e);
      throw e;
    }

    if (this.#attempt > 0) this.restarts++;
    this.#attempt = 0;
    this.needsAuth = false;
    this.state = "up";
    this.lastError = undefined;
    this.onEvent?.("backend_up", { server: this.name, tools: this.tools.length, pid: this.pid });
    this.onChange?.(this);
  }

  /**
   * Everything this backend offers. Pagination is collapsed — the gateway serves one merged
   * page (SPEC 4.1) — and a capability the server does not advertise is simply empty.
   */
  async refresh(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const capabilities = client.getServerCapabilities();

    this.tools = capabilities?.tools
      ? await this.#pages(
          (cursor) => client.listTools(cursor, this.#opts()),
          (page) => page.tools,
        )
      : [];

    this.prompts = capabilities?.prompts
      ? await this.#pages(
          (cursor) => client.listPrompts(cursor, this.#opts()),
          (page) => page.prompts,
        )
      : [];

    if (capabilities?.resources) {
      this.resources = await this.#pages(
        (cursor) => client.listResources(cursor, this.#opts()),
        (page) => page.resources,
      );
      // Optional even when `resources` is advertised, so a refusal here is not a failure.
      this.resourceTemplates = await this.#pages(
        (cursor) => client.listResourceTemplates(cursor, this.#opts()),
        (page) => page.resourceTemplates,
      ).catch(() => []);
    } else {
      this.resources = [];
      this.resourceTemplates = [];
    }
  }

  /**
   * Aborting `signal` makes the SDK send notifications/cancelled to the backend (SPEC 4.3).
   * `onprogress` is registered under the request's own id, so the SDK hands each progress note to
   * the call that asked for it — no token map, and no chance of one client seeing another's.
   * Progress also proves the call alive: it restarts `call_timeout_ms`, up to `max_call_ms`.
   */
  #opts(from: Caller = {}): RequestOptions {
    return {
      timeout: this.defaults.call_timeout_ms,
      signal: from.signal,
      onprogress: from.onprogress,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: this.defaults.max_call_ms,
    };
  }

  /** Walks nextCursor to the end and returns everything as one list. */
  async #pages<P extends { nextCursor?: string }, T>(
    fetch: (cursor: Record<string, string>) => Promise<P>,
    items: (page: P) => T[],
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetch(cursor === undefined ? {} : { cursor });
      all.push(...items(page));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return all;
  }

  async callTool(
    tool: string,
    args: Record<string, unknown> | undefined,
    from: Caller = {},
  ): Promise<CallToolResult> {
    return this.#request(
      "tools/call",
      tool,
      (client) =>
        client.callTool(
          { name: tool, arguments: args },
          CallToolResultSchema,
          this.#opts(from),
        ) as Promise<CallToolResult>,
      from.caller,
    );
  }

  async readResource(uri: string, from: Caller = {}): Promise<ReadResourceResult> {
    return this.#request(
      "resources/read",
      uri,
      (client) => client.readResource({ uri }, this.#opts(from)),
      from.caller,
    );
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    from: Caller = {},
  ): Promise<GetPromptResult> {
    return this.#request(
      "prompts/get",
      name,
      (client) => client.getPrompt({ name, arguments: args }, this.#opts(from)),
      from.caller,
    );
  }

  async subscribe(uri: string): Promise<void> {
    await this.#request("resources/subscribe", uri, (client) =>
      client.subscribeResource({ uri }, this.#opts()),
    );
  }

  async unsubscribe(uri: string): Promise<void> {
    await this.#request("resources/unsubscribe", uri, (client) =>
      client.unsubscribeResource({ uri }, this.#opts()),
    );
  }

  async complete(params: CompleteRequest["params"], from: Caller = {}): Promise<CompleteResult> {
    return this.#request(
      "completion/complete",
      params.ref.type,
      (client) => client.complete(params, this.#opts(from)),
      from.caller,
    );
  }

  /**
   * The shared shape of every call: refuse when down, hold the caller as the reverse-request
   * target while it runs, wrap what the backend throws.
   */
  async #request<T>(
    method: string,
    what: string,
    run: (client: Client) => Promise<T>,
    caller?: ReverseTarget,
  ): Promise<T> {
    // A tool call reports under the tool's own name; anything else as "method what".
    const label = method === "tools/call" ? what : `${method} ${what}`;
    const client = this.#client;
    if (!client || this.state !== "up") {
      throw gwError(ERR.BACKEND_DOWN, `backend "${this.name}" is ${this.state}`, {
        reason: "server_unavailable",
        server: this.name,
        tool: label,
      });
    }
    if (caller) this.#inflight.set(caller, (this.#inflight.get(caller) ?? 0) + 1);
    try {
      return await run(client);
    } catch (e) {
      throw this.#wrap(e, label);
    } finally {
      if (caller) {
        const left = (this.#inflight.get(caller) ?? 1) - 1;
        if (left > 0) this.#inflight.set(caller, left);
        else this.#inflight.delete(caller);
      }
    }
  }

  /**
   * Routes a backend→client request to the session that owns the call it arrived during.
   *
   * ponytail: single-session routing only. Nothing on the wire ties a reverse request to the call
   * it serves (`relatedRequestId` is an SDK transport option, never serialized over stdio), so
   * when calls from two different sessions are outstanding on one backend the request gets
   * -32006 rather than a guess: the failure is visible, and guessing would leak one client's
   * prompt to another. Upgrade: a backend-side `_meta` convention, or a per-server concurrency
   * limit of 1 for backends that sample.
   */
  #route(method: string): ReverseTarget {
    if (this.#inflight.size !== 1) {
      // `decision`, not just `method`: PRD 8.5 greps the log with `select(.decision != "allow")`.
      this.onEvent?.("unroutable", {
        server: this.name,
        decision: "unroutable",
        rpc_method: method,
        inflight: this.#inflight.size,
      });
      throw gwError(ERR.UNROUTABLE, `cannot route ${method} from "${this.name}" to a session`, {
        reason: "unroutable",
        server: this.name,
      });
    }
    return [...this.#inflight.keys()][0]!;
  }

  async #relist(): Promise<void> {
    if (this.state !== "up") return;
    try {
      await this.refresh();
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
    this.#failAndRetry(new Error(reason));
    this.onChange?.(this);
  }

  /**
   * Every failure path retries — a slow `npx` cold start is indistinguishable from a crash —
   * except one: retrying an expired authorization just burns backoff until someone runs
   * `mcpgw auth`. That one stops and says so.
   */
  #failAndRetry(error: unknown): void {
    // An OAuth backend with nothing in the token store cannot be fixed by waiting: whatever
    // went wrong — a 401, or a server that advertises dynamic registration and then 403s it —
    // the next attempt does exactly the same thing.
    const unauthorized = error instanceof UnauthorizedError || error instanceof NeedsAuthorization;
    const needsAuth = unauthorized || (this.authProvider !== undefined && !this.#hasTokens());
    this.needsAuth = needsAuth;
    this.#fail(
      needsAuth
        ? `needs authorization: run \`mcpgw auth ${this.name}\``
        : ((error as Error).message ?? String(error)),
    );
    if (!needsAuth) this.#scheduleRestart();
  }

  #fail(reason: string): void {
    this.state = "down";
    this.lastError = reason;
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.resourceTemplates = [];
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

  #hasTokens(): boolean {
    const tokens = this.authProvider?.tokens();
    return tokens !== undefined && !(tokens instanceof Promise) && Boolean(tokens.access_token);
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#retry);
    const orphan = this.pid;
    this.state = "down";
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.resourceTemplates = [];
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    if (client) await closeTree(client, orphan);
  }
}

/**
 * Closes a client, then whatever its process left running. The SDK stops only the process it
 * spawned, which for `npx` is a launcher whose `node` grandchild can outlive it — every restart
 * would leak a backend. So the tree is listed first, while the launcher still owns it, and
 * anything in it that survives the SDK's own shutdown is killed.
 *
 * ponytail: not on the crash path. Once the launcher is dead its children are re-parented, and a
 * stale listing could name a pid the OS has since reused. Upgrade: own the spawn, detached, and
 * signal the process group.
 */
async function closeTree(client: Client, pid: number | null | undefined): Promise<void> {
  const tree = pid ? await descendants(pid) : [];
  await client.close().catch(() => {});
  for (const child of tree) {
    try {
      process.kill(child, "SIGKILL"); // TerminateProcess on Windows
    } catch {
      // Already gone: the common case, when the backend exits on stdin EOF as it should.
    }
  }
}

let listing: Promise<Map<number, number[]>> | undefined;

/**
 * pid → child pids, from one OS listing. A shutdown closes every backend at once and PowerShell
 * takes most of a second to answer on Windows, so closes that overlap share the listing in flight.
 * Only in flight: a finished one predates any process started since, which is what it must find.
 */
function processTable(): Promise<Map<number, number[]>> {
  if (listing) return listing;
  const [command, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
        ]
      : ["ps", ["-A", "-o", "pid=,ppid="]];
  const table = promisify(execFile)(command, args, { timeout: 5000, windowsHide: true })
    .then(({ stdout }) => {
      const children = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (!pid || ppid === undefined || !Number.isInteger(ppid)) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      }
      return children;
    })
    .catch(() => new Map<number, number[]>()) // no listing: fall back to the SDK's own kill
    .finally(() => {
      listing = undefined;
    });
  listing = table;
  return table;
}

async function descendants(root: number): Promise<number[]> {
  const children = await processTable();
  const found: number[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      // Windows reuses pids, so its parent links can loop.
      if (child === root || found.includes(child)) continue;
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}
