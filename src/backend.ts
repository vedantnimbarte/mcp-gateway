import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_INFO, type Config, type ServerConfig } from "./config.js";
import { ERR, gwError } from "./errors.js";

export type BackendState = "connecting" | "up" | "down";

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
 * One backend server: its connection, its tools, its state. Shared by every session
 * (ARCHITECTURE §1). Supervision, backoff and reconnection arrive in Phase 2.
 */
export class Backend {
  state: BackendState = "connecting";
  tools: Tool[] = [];
  lastError?: string;
  #client?: Client;

  constructor(
    readonly name: string,
    readonly config: ServerConfig,
    private readonly defaults: Config["defaults"],
  ) {}

  async start(): Promise<void> {
    this.state = "connecting";
    const client = new Client({ ...GATEWAY_INFO }, { capabilities: {} });
    try {
      await client.connect(makeTransport(this.config), {
        timeout: this.defaults.connect_timeout_ms,
      });
      this.#client = client;
      this.tools = await this.refreshTools();
      this.state = "up";
      this.lastError = undefined;
    } catch (e) {
      this.state = "down";
      this.lastError = (e as Error).message;
      await client.close().catch(() => {});
      throw e;
    }
  }

  /** Pagination is collapsed here — the gateway serves one merged page (SPEC §4.1). */
  async refreshTools(): Promise<Tool[]> {
    const client = this.#client;
    if (!client || !client.getServerCapabilities()?.tools) return [];

    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { timeout: this.defaults.call_timeout_ms },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(tool: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const client = this.#client;
    if (!client || this.state !== "up") {
      throw gwError(ERR.BACKEND_DOWN, `backend "${this.name}" is ${this.state}`, {
        reason: "server_unavailable",
        server: this.name,
        tool,
      });
    }
    try {
      return (await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
        timeout: this.defaults.call_timeout_ms,
      })) as CallToolResult;
    } catch (e) {
      throw this.#wrap(e, tool);
    }
  }

  /** Backend failures are wrapped with the gateway's own code; the original travels in `data`. */
  #wrap(e: unknown, tool: string): Error {
    if (!(e instanceof McpError)) return e as Error;
    const context = { server: this.name, tool, upstream: { code: e.code, message: e.message } };

    if (e.code === ErrorCode.RequestTimeout) {
      return gwError(ERR.TIMEOUT, `${this.name}__${tool} timed out`, {
        reason: "timeout",
        ...context,
      });
    }
    if (e.code === ErrorCode.ConnectionClosed) {
      this.state = "down";
      return gwError(ERR.BACKEND_DOWN, `backend "${this.name}" closed the connection`, {
        reason: "server_unavailable",
        ...context,
      });
    }
    return e;
  }

  async close(): Promise<void> {
    this.state = "down";
    await this.#client?.close().catch(() => {});
    this.#client = undefined;
  }
}

export function createBackends(config: Config): Map<string, Backend> {
  return new Map(
    Object.entries(config.servers).map(([name, cfg]) => [
      name,
      new Backend(name, cfg, config.defaults),
    ]),
  );
}

/** Connects everything in parallel; one slow or broken backend never blocks its peers (NFR-5/6). */
export async function startBackends(
  backends: Iterable<Backend>,
  onError: (name: string, error: Error) => void,
): Promise<void> {
  await Promise.all(
    [...backends].map((b) => b.start().catch((e: Error) => onError(b.name, e))),
  );
}
