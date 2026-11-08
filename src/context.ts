import { spawn } from "node:child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLog } from "./audit.js";
import type { ProfileConfig } from "./config.js";
import type { CallContext, Pipeline } from "./pipeline.js";

/**
 * Keeping the model's context small (profiles.*.context). Three independent switches:
 *
 * - `tools: lazy` lists four small tools instead of every schema; the model searches, then loads
 *   only the schemas it needs.
 * - `handle_bytes` keeps any result larger than that in the session and returns a handle, its
 *   shape and a preview; `query_result` reads slices of it.
 * - `code` adds `run_code`: a script calls tools in a locked-down child process and only what it
 *   prints or returns comes back, so intermediate results never enter the context at all.
 *
 * Everything still goes through Pipeline.callTool, so policy, approvals, limits, redaction and
 * the audit log apply to every call these make, exactly as to a direct one.
 */

export type ContextConfig = ProfileConfig["context"];

const OFF: ContextConfig = { tools: "full", code: false, code_timeout_ms: 30000 };

/** What one handle may hold. Past this a result is cut like any other, just much later. */
export const STORE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Per session; the oldest handles go first once either bound is passed.
 * ponytail: in memory and per session, so a handle dies with its session or a restart.
 */
const STORE_MAX_HANDLES = 64;
const STORE_TOTAL_BYTES = 64 * 1024 * 1024;
const PREVIEW_ITEMS = 3;
const PREVIEW_CHARS = 300;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** What run_code's console output may total before further lines are dropped. */
const LOG_BYTES = 1024 * 1024;

const META: Record<string, Tool> = {
  search_tools: {
    name: "search_tools",
    description:
      "Find tools by keyword. Returns names with a one-line summary; an empty query lists " +
      "everything. Load a tool's arguments with describe_tool, then run it with call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in tool names and descriptions" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
  },
  describe_tool: {
    name: "describe_tool",
    description: "The full description and input schema of one or more tools, by exact name.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["names"],
    },
  },
  call_tool: {
    name: "call_tool",
    description: "Run a tool found with search_tools, with arguments matching its input schema.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object" } },
      required: ["name"],
    },
  },
  query_result: {
    name: "query_result",
    description:
      "Read part of a large result the gateway kept as a handle. `path` walks into it " +
      '("items", "data.0.owner"); on a list, `where` keeps items whose fields equal the given ' +
      'values ({"status": "open", "owner.login": "ana"}), `contains` keeps items mentioning a ' +
      "string, `fields` keeps only those fields, and `offset`/`limit` page through what is left. " +
      "Text results are a list of lines.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        path: { type: "string" },
        where: { type: "object" },
        contains: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      required: ["handle"],
    },
  },
  run_code: {
    name: "run_code",
    description:
      "Run JavaScript (the body of an async function) in a sandbox, to chain tool calls or " +
      "filter big results without returning them whole. `await tools.call(name, args)` runs a " +
      "tool under the same rules as call_tool and returns its result parsed: JSON when the " +
      "result is JSON, else its text; a tool error throws. `await tools.search(query)` finds " +
      "tool names. Only console.log output and the returned value come back. No file system, " +
      "no processes, no environment.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
};

const invalid = (why: string) => new McpError(ErrorCode.InvalidParams, why);
const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError } : {}),
});
const sizeOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "");
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The value a result carries: structured content, else JSON text, else the text, else the blocks. */
export function dataOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length > 0 && content.every((c) => c.type === "text")) {
    const body = content.map((c) => (c as { text: string }).text).join("\n");
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return content;
}

/** A compact type sketch: `array[1840] of {id: number, owner: {login: string}}`. */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return depth === 0 ? `text, ${value.split("\n").length} lines` : "string";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Merge the keys of the first few items, so an optional field still shows up.
    const objects = value.slice(0, 20).filter(isObject);
    const sample = objects.length > 0 ? Object.assign({}, ...objects.reverse()) : value[0];
    return `array[${value.length}] of ${shapeOf(sample, depth + 1)}`;
  }
  if (isObject(value)) {
    if (depth >= 3) return "{…}";
    const keys = Object.keys(value);
    const shown = keys.slice(0, 15).map((k) => `${k}: ${shapeOf(value[k], depth + 1)}`);
    const more = keys.length > 15 ? `, …${keys.length - 15} more` : "";
    return `{${shown.join(", ")}${more}}`;
  }
  return typeof value;
}

/** `a.b.0.c` into a value; undefined when any step is missing. */
function at(value: unknown, path: string): unknown {
  let here = value;
  for (const step of path.split(".").filter(Boolean)) {
    if (Array.isArray(here) && /^\d+$/.test(step)) here = here[Number(step)];
    else if (isObject(here)) here = here[step];
    else return undefined;
  }
  return here;
}

export interface Query {
  path?: string;
  where?: Record<string, unknown>;
  contains?: string;
  fields?: string[];
  offset?: number;
  limit?: number;
}

/** query_result over a kept value, never returning more than `max` bytes. */
export function runQuery(data: unknown, q: Query, max: number): unknown {
  let target = q.path ? at(data, q.path) : data;
  if (target === undefined) throw invalid(`nothing at path "${q.path}"`);
  if (typeof target === "string") target = target.split("\n");

  const project = (row: unknown) =>
    q.fields && isObject(row) ? Object.fromEntries(q.fields.map((f) => [f, at(row, f)])) : row;

  if (!Array.isArray(target)) {
    const value = project(target);
    if (sizeOf(value) <= max) return value;
    return {
      too_large: `${sizeOf(value)} bytes; pick a narrower path or fewer fields`,
      shape: shapeOf(value),
    };
  }

  let rows: unknown[] = target;
  if (q.where) {
    const wanted = Object.entries(q.where).map(([k, v]) => [k, JSON.stringify(v)] as const);
    rows = rows.filter((row) => wanted.every(([k, v]) => JSON.stringify(at(row, k)) === v));
  }
  if (q.contains) {
    const needle = q.contains.toLowerCase();
    rows = rows.filter((row) =>
      (typeof row === "string" ? row : JSON.stringify(row)).toLowerCase().includes(needle),
    );
  }

  const offset = q.offset ?? 0;
  const build = (n: number) => {
    const items = rows.slice(offset, offset + n).map(project);
    const next = offset + items.length;
    return { total: rows.length, offset, returned: items.length, items, ...(next < rows.length ? { next_offset: next } : {}) };
  };
  // Measured, then shrunk until it fits: rows vary too much in size to predict a count.
  let n = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  let out = build(n);
  while (out.returned > 0 && sizeOf(out) > max) {
    n = Math.min(out.returned - 1, Math.floor((out.returned * max) / sizeOf(out)));
    out = build(n);
  }
  if (out.returned === 0 && rows.length > offset) {
    return { ...out, too_large: "one item is over the budget; narrow it with fields or path" };
  }
  return out;
}

/** The session's kept results, oldest evicted first. */
class Handles {
  readonly #items = new Map<string, { data: unknown; bytes: number }>();
  #next = 1;
  #bytes = 0;

  put(data: unknown, bytes: number): string {
    const id = `r${this.#next++}`;
    this.#items.set(id, { data, bytes });
    this.#bytes += bytes;
    while (this.#items.size > 1 && (this.#items.size > STORE_MAX_HANDLES || this.#bytes > STORE_TOTAL_BYTES)) {
      const [oldest, item] = this.#items.entries().next().value!;
      this.#items.delete(oldest);
      this.#bytes -= item.bytes;
    }
    return id;
  }

  get(id: string): unknown {
    if (!this.#items.has(id)) throw invalid(`unknown or expired handle "${id}"`);
    return this.#items.get(id)!.data;
  }
}

function preview(data: unknown): string {
  if (typeof data === "string") {
    return data.split("\n").slice(0, 5).map((l) => clip(l, 200)).join("\n");
  }
  if (Array.isArray(data)) {
    return data
      .slice(0, PREVIEW_ITEMS)
      .map((item) => clip(JSON.stringify(item), PREVIEW_CHARS))
      .join("\n");
  }
  return "";
}

function brief(description: string | undefined): string {
  const first = (description ?? "").split(/(?<=\.)\s|\n/)[0] ?? "";
  return clip(first.trim(), 160);
}

/**
 * Runs inside `node --permission` with no --allow-* flags: no file system, no child processes,
 * no workers, no native addons, and an empty environment, so none of the daemon's credentials.
 * Tool calls go back to the parent over IPC, which is the only way out to a backend.
 *
 * ponytail: the permission model does not restrict the network on Node 22–24, so a script can
 * still reach the internet like the client that sent it could. Upgrade: `--allow-net` once the
 * baseline is a Node that has it, or a container.
 */
const RUNNER = String.raw`
const pending = new Map(); let next = 0;
const ask = (msg) => new Promise((resolve, reject) => {
  const id = next++; pending.set(id, { resolve, reject }); process.send({ ...msg, id });
});
const parse = (r) => {
  const content = r.content || [];
  const body = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) throw new Error(body || "tool error");
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (content.length > 0 && content.every((c) => c.type === "text")) {
    try { return JSON.parse(body); } catch { return body; }
  }
  return content;
};
const tools = Object.freeze({
  call: async (name, args) => parse(await ask({ type: "call", name, args: args ?? {} })),
  search: (query) => ask({ type: "search", query: query ?? "" }),
});
const show = (v) => { if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } };
const logs = []; let size = 0; let dropped = 0;
console.log = console.info = console.warn = console.error = console.debug = (...a) => {
  const line = a.map(show).join(" ");
  if (size + line.length > ${LOG_BYTES}) { dropped++; return; }
  size += line.length; logs.push(line);
};
process.on("message", async (m) => {
  if (m.type === "reply") {
    const p = pending.get(m.id); pending.delete(m.id);
    if (p) m.error !== undefined ? p.reject(new Error(m.error)) : p.resolve(m.value);
    return;
  }
  if (m.type !== "run") return;
  let out;
  try {
    const value = await new (async () => {}).constructor("tools", m.code)(tools);
    out = { type: "done", logs, dropped, value: value === undefined ? undefined : show(value) };
  } catch (e) {
    out = { type: "done", logs, dropped, error: e && e.message ? e.name + ": " + e.message : String(e) };
  }
  process.send(out, () => process.exit(0));
});
`;

interface Settings {
  context?: ContextConfig;
  /** guard.max_result_bytes: what run_code's output is cut to when there are no handles. */
  maxResultBytes: number;
}

/** One per session: the handles are that session's, like its request ids. */
export class ContextTools {
  readonly #handles = new Handles();

  constructor(
    private readonly pipeline: Pipeline,
    private readonly audit: AuditLog,
    private readonly profile: string,
    private readonly settings: () => Settings,
  ) {}

  #cfg(): ContextConfig {
    return this.settings().context ?? OFF;
  }

  /** The gateway's own tools this profile currently has switched on. */
  #active(): string[] {
    const c = this.#cfg();
    const names = c.tools === "lazy" ? ["search_tools", "describe_tool", "call_tool"] : [];
    if (c.handle_bytes !== undefined) names.push("query_result");
    if (c.code) names.push("run_code");
    return names;
  }

  /** What `tools/list` returns. */
  list(): Tool[] {
    const meta = this.#active().map((n) => META[n]!);
    return this.#cfg().tools === "lazy" ? meta : [...this.pipeline.visibleTools(this.profile), ...meta];
  }

  async call(ctx: CallContext, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (!this.#active().includes(name)) return this.#tool(ctx, name, args, false);
    switch (name) {
      case "search_tools":
        return text(this.#searchText(String(args.query ?? ""), Number(args.limit ?? DEFAULT_LIMIT)));
      case "describe_tool":
        return this.#describe(args.names);
      case "call_tool":
        if (typeof args.name !== "string") throw invalid("call_tool needs a tool name");
        if (args.arguments !== undefined && !isObject(args.arguments)) {
          throw invalid("call_tool: arguments must be an object");
        }
        // A model often leaves `arguments` out for a no-argument tool; backends expect an object.
        return this.#tool(ctx, args.name, (args.arguments ?? {}) as Record<string, unknown>, true);
      case "query_result": {
        if (typeof args.handle !== "string") throw invalid("query_result needs a handle");
        const data = this.#handles.get(args.handle);
        return text(JSON.stringify(runQuery(data, args as Query, this.#cfg().handle_bytes!)));
      }
      default: {
        if (typeof args.code !== "string") throw invalid("run_code needs code");
        return this.#runCode(ctx, args.code);
      }
    }
  }

  /** A backend tool, through the pipeline; a large result is kept and replaced by its handle. */
  async #tool(
    ctx: CallContext,
    name: string,
    args: Record<string, unknown> | undefined,
    viaMeta: boolean,
  ): Promise<CallToolResult> {
    const max = this.#cfg().handle_bytes;
    // A tool with an output schema called by its own name must return its structured content,
    // which a handle summary would not; those are capped as usual instead.
    const typed = !viaMeta && this.pipeline.visibleTools(this.profile).some((t) => t.name === name && t.outputSchema);
    if (max === undefined || typed) return this.pipeline.callTool(ctx, name, args);
    return this.#keep(ctx, await this.pipeline.callTool({ ...ctx, maxResultBytes: STORE_MAX_BYTES }, name, args), max);
  }

  #keep(ctx: CallContext, result: CallToolResult, max: number): CallToolResult {
    const bytes = sizeOf(result);
    if (bytes <= max) return result;
    const data = dataOf(result);
    const handle = this.#handles.put(data, bytes);
    const shown = preview(data);
    // What stayed out of the model's context: the status page totals it.
    this.audit.write({ method: "handle", session: ctx.session, profile: ctx.profile, client: ctx.client, client_key: ctx.clientKey, handle, result_bytes: bytes });
    return text(
      [
        `Result too large to return whole (${bytes.toLocaleString("en-US")} bytes, ` +
          `~${Math.round(bytes / 4).toLocaleString("en-US")} tokens), kept as handle "${handle}".`,
        `Shape: ${shapeOf(data)}`,
        ...(shown ? ["Preview:", shown] : []),
        `Read what you need with query_result({"handle": "${handle}", ...}) — path, where, ` +
          `contains, fields, offset, limit.`,
      ].join("\n"),
      result.isError === true,
    );
  }

  #search(query: string, limit: number): { total: number; tools: { name: string; description: string }[] } {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = this.pipeline
      .visibleTools(this.profile)
      .map((tool) => {
        const name = tool.name.toLowerCase();
        const description = (tool.description ?? "").toLowerCase();
        let score = 0;
        for (const term of terms) score += name.includes(term) ? 3 : description.includes(term) ? 1 : 0;
        return { tool, score };
      })
      .filter((s) => terms.length === 0 || s.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? limit : DEFAULT_LIMIT, MAX_LIMIT));
    return {
      total: scored.length,
      tools: scored.slice(0, n).map(({ tool }) => ({ name: tool.name, description: brief(tool.description) })),
    };
  }

  #searchText(query: string, limit: number): string {
    const { total, tools } = this.#search(query, limit);
    if (total === 0) return `No tool matches "${query}". Try other words, or an empty query to list all.`;
    const lines = tools.map((t) => (t.description ? `${t.name} — ${t.description}` : t.name));
    if (total > tools.length) lines.push(`(${tools.length} of ${total}; narrow the query or raise limit)`);
    return lines.join("\n");
  }

  #describe(names: unknown): CallToolResult {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      throw invalid("describe_tool needs names: a list of tool names");
    }
    const visible = new Map(this.pipeline.visibleTools(this.profile).map((t) => [t.name, t]));
    const tools = names.flatMap((n) => {
      const t = visible.get(n);
      return t ? [{ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema }] : [];
    });
    const missing = names.filter((n) => !visible.has(n));
    return text(JSON.stringify(missing.length > 0 ? { tools, missing } : { tools }));
  }

  async #runCode(ctx: CallContext, code: string): Promise<CallToolResult> {
    const started = Date.now();
    const cfg = this.#cfg();
    const child = spawn(process.execPath, ["--permission", "--max-old-space-size=256", "-e", RUNNER], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Nothing of the daemon's: its environment is where the backends' credentials live.
      env: process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {},
      windowsHide: true,
    });
    const post = (m: unknown) => {
      try {
        child.send(m as never);
      } catch {
        // The sandbox is already gone; whatever ended it settles the call.
      }
    };

    const outcome = await new Promise<{ result: CallToolResult; status: "ok" | "error" | "timeout" }>((resolve) => {
      let settled = false;
      let stderr = "";
      const finish = (result: CallToolResult, status: "ok" | "error" | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        child.kill();
        resolve({ result, status });
      };
      const timer = setTimeout(
        () => finish(text(`run_code timed out after ${cfg.code_timeout_ms} ms`, true), "timeout"),
        cfg.code_timeout_ms,
      );
      const onAbort = () => finish(text("run_code was cancelled", true), "error");
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr!.on("data", (d) => {
        if (stderr.length < 4000) stderr += String(d);
      });
      child.on("error", (e) => finish(text(`sandbox failed to start: ${e.message}`, true), "error"));
      // `close`, not `exit`, and a tick later: the "done" message must win the race against the
      // exit that follows it.
      child.on("close", (status) =>
        setImmediate(() =>
          finish(text(`sandbox exited (${status})${stderr ? `: ${clip(stderr.trim(), 2000)}` : ""}`, true), "error"),
        ),
      );
      child.on("message", (m: Record<string, unknown>) => {
        if (m.type === "search") {
          post({ type: "reply", id: m.id, value: this.#search(String(m.query ?? ""), MAX_LIMIT).tools });
        } else if (m.type === "call") {
          this.pipeline
            .callTool({ ...ctx, maxResultBytes: STORE_MAX_BYTES }, String(m.name), m.args as Record<string, unknown>)
            .then(
              (value) => post({ type: "reply", id: m.id, value }),
              (e: Error) => post({ type: "reply", id: m.id, error: e.message }),
            );
        } else if (m.type === "done") {
          const logs = (m.logs as string[]).join("\n");
          const dropped = m.dropped ? `\n(${String(m.dropped)} more log lines dropped)` : "";
          if (typeof m.error === "string") {
            finish(text(`${logs}${dropped}${logs ? "\n" : ""}${m.error}`, true), "error");
          } else {
            const value = typeof m.value === "string" ? m.value : "";
            const body = logs && value ? `${logs}${dropped}\n\nreturned: ${value}` : `${logs}${dropped}${value}`;
            finish(text(body || "(no output)"), "ok");
          }
        }
      });
      post({ type: "run", code });
    });

    this.audit.write({
      method: "run_code",
      session: ctx.session,
      profile: ctx.profile,
      client: ctx.client,
      client_key: ctx.clientKey,
      ...this.audit.argFields({ code }),
      decision: "allow",
      status: outcome.status,
      dur_ms: Date.now() - started,
    });

    const max = cfg.handle_bytes;
    if (max !== undefined) return this.#keep(ctx, outcome.result, max);
    const body = (outcome.result.content![0] as { text: string }).text;
    const limit = this.settings().maxResultBytes;
    if (Buffer.byteLength(body) <= limit) return outcome.result;
    const kept = Buffer.from(body).subarray(0, limit).toString("utf8");
    return text(`${kept}\n\n[truncated by mcp-gateway: ${Buffer.byteLength(body) - Buffer.byteLength(kept)} bytes omitted]`, outcome.result.isError === true);
  }
}
