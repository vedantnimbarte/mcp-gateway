import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditInput, AuditLine, AuditLog } from "./audit.js";
import type { Backend, ReverseTarget } from "./backend.js";
import { parseUri, type CatalogEntry } from "./catalog.js";
import type { Config } from "./config.js";
import { ERR, gwError } from "./errors.js";
import type { Guard } from "./guard.js";
import { decide, reaches, type Decision } from "./policy.js";
import type { Pool } from "./pool.js";
import { limitersFor, type Limiter } from "./ratelimit.js";

export interface ExposedTool {
  entry: CatalogEntry;
  /** The name the client sees: the alias when renamed, else the canonical name. */
  exposed: string;
}

export interface Explanation extends ExposedTool {
  decision: Decision;
}

/** Who is calling. Everything here ends up in the audit line. */
export interface CallContext {
  profile: string;
  session?: string;
  client?: { name: string; version: string };
  /** The session, as something a backend can send a reverse request to. */
  caller?: ReverseTarget;
  /** Aborted when the client cancels; carried through to the backend (SPEC 4.3). */
  signal?: AbortSignal;
}

/** SPEC §3.3: under `on_drift: warn` a changed tool is still listed, but flagged. */
const WARN_PREFIX = "⚠ [unverified change] ";

/**
 * SPEC §5, in order: resolve → policy → limit → guard-in → dispatch → guard-out → audit →
 * release. Policy runs before the limiter so a denied call burns no budget, and the release is
 * in a `finally` so a throwing backend cannot leak a slot.
 */
export class Pipeline {
  #limiters: Map<string, Limiter>;
  /** alias → canonical, per profile. Renames are static between reloads, so this is built once. */
  #aliases = new Map<string, Map<string, string>>();
  /** namespaced resource URI -> the sessions watching it, so a backend is subscribed once. */
  readonly #watchers = new Map<string, Set<string>>();

  constructor(
    private config: Config,
    private readonly pool: Pool,
    private readonly guard: Guard,
    private readonly audit: AuditLog,
    private readonly now?: () => number,
  ) {
    this.#limiters = limitersFor(config, now);
    for (const [name, profile] of Object.entries(config.profiles)) {
      const byAlias = new Map<string, string>();
      for (const [canonical, alias] of Object.entries(profile.rename)) byAlias.set(alias, canonical);
      this.#aliases.set(name, byAlias);
    }
  }

  /** Calls currently dispatched to a backend, across every profile — what a drain waits for. */
  get inflight(): number {
    let total = 0;
    for (const limiter of this.#limiters.values()) total += limiter.inflight;
    return total;
  }

  /** SIGHUP: new profiles, globs, renames and limits take effect on the next call. */
  reload(config: Config): void {
    this.config = config;
    this.#limiters = limitersFor(config, this.now);
    this.#aliases = new Map();
    for (const [name, profile] of Object.entries(config.profiles)) {
      const byAlias = new Map<string, string>();
      for (const [canonical, alias] of Object.entries(profile.rename)) byAlias.set(alias, canonical);
      this.#aliases.set(name, byAlias);
    }
  }

  /** Every tool in the catalog with the decision that produced its visibility — `mcpgw list`. */
  explain(profileName: string): Explanation[] {
    const profile = this.config.profiles[profileName];
    return this.pool.catalog.all().map((entry) => ({
      entry,
      exposed: profile?.rename[entry.canonical] ?? entry.canonical,
      decision: this.#decide(profileName, entry),
    }));
  }

  /** What `tools/list` returns: allowed tools only, renamed (SPEC §3.3). */
  visibleTools(profileName: string): Tool[] {
    return this.explain(profileName)
      .filter((row) => row.decision.allow)
      .map((row) => {
        const drifted = this.guard.isDrifted(row.entry.server, row.entry.tool);
        return {
          ...row.entry.def,
          name: row.exposed,
          description: drifted
            ? WARN_PREFIX + (row.entry.def.description ?? "")
            : row.entry.def.description,
        };
      });
  }

  /** Prompts are named like tools, so the same allow/deny decision applies to them. */
  visiblePrompts(profileName: string): Prompt[] {
    const profile = this.config.profiles[profileName];
    return this.pool.catalog
      .allPrompts()
      .filter((entry) => this.#decideNamed(profileName, entry.canonical, entry.server).allow)
      .map((entry) => ({ ...entry.def, name: profile?.rename[entry.canonical] ?? entry.canonical }));
  }

  /** Resources are filtered by server membership only (SPEC 4.1). */
  visibleResources(profileName: string): Resource[] {
    const profile = this.config.profiles[profileName];
    return this.pool.catalog
      .allResources()
      .filter((entry) => reaches(profile, entry.server))
      .map((entry) => entry.def as Resource);
  }

  visibleTemplates(profileName: string): ResourceTemplate[] {
    const profile = this.config.profiles[profileName];
    return this.pool.catalog
      .allTemplates()
      .filter((entry) => reaches(profile, entry.server))
      .map((entry) => entry.def as ResourceTemplate);
  }

  /** Stable fingerprints of a profile's visible sets, for suppressing no-op notifications. */
  visibleFingerprint(profileName: string): string {
    return this.visibleTools(profileName)
      .map((t) => t.name)
      .sort()
      .join(" ");
  }

  promptFingerprint(profileName: string): string {
    return this.visiblePrompts(profileName)
      .map((p) => p.name)
      .sort()
      .join(" ");
  }

  resourceFingerprint(profileName: string): string {
    return [
      ...this.visibleResources(profileName).map((r) => r.uri),
      ...this.visibleTemplates(profileName).map((t) => t.uriTemplate),
    ]
      .sort()
      .join(" ");
  }

  async callTool(
    ctx: CallContext,
    exposed: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const started = Date.now();
    const line: AuditInput = {
      method: "tools/call",
      session: ctx.session,
      profile: ctx.profile,
      client: ctx.client,
      exposed_as: exposed,
      ...this.audit.argFields(args),
    };
    const fail = (e: Error & { code?: number }, decision: AuditLine["decision"]): never => {
      this.audit.write({
        ...line,
        decision,
        status: decision === "allow" ? "error" : "denied",
        dur_ms: Date.now() - started,
        error: { code: e.code ?? -32603, message: this.guard.redactText(e.message) },
      });
      throw e;
    };

    // 1. resolve. An alias resolves to its canonical name; the canonical name always resolves
    //    to itself, and policy is evaluated on it either way, so a rename is never a bypass.
    const canonical = this.#aliases.get(ctx.profile)?.get(exposed) ?? exposed;
    const entry = this.pool.catalog.get(canonical);
    if (!entry) {
      return fail(new McpError(ErrorCode.MethodNotFound, `unknown tool "${exposed}"`), undefined);
    }
    line.server = entry.server;
    line.tool = entry.tool;

    // 2. policy
    const decision = this.#decide(ctx.profile, entry);
    if (!decision.allow) {
      const code = decision.reason === "server_unavailable" ? ERR.BACKEND_DOWN : ERR.POLICY;
      return fail(
        gwError(code, `"${exposed}" is not available: ${decision.reason}`, {
          reason: decision.reason,
          profile: ctx.profile,
          server: entry.server,
          tool: entry.tool,
        }),
        decision.reason,
      );
    }

    // 3. limit
    const limiter = this.#limiters.get(ctx.profile);
    const grant = limiter?.acquire() ?? { ok: true as const };
    if (!grant.ok) {
      return fail(
        gwError(ERR.RATE_LIMITED, `profile "${ctx.profile}" is over its limit`, {
          reason: "rate_limited",
          profile: ctx.profile,
          retry_after_ms: grant.retryAfterMs,
        }),
        "rate_limited",
      );
    }

    try {
      // 4. guard-in: the arguments must fit the schema the backend published.
      const invalid = this.guard.validateArgs(canonical, entry.def, args);
      if (invalid) {
        return fail(
          new McpError(ErrorCode.InvalidParams, `invalid arguments for "${exposed}": ${invalid}`),
          "allow",
        );
      }

      // 5. dispatch
      const backend = this.pool.backends.get(entry.server);
      if (!backend) {
        return fail(
          gwError(ERR.BACKEND_DOWN, `backend "${entry.server}" is gone`, {
            reason: "server_unavailable",
            server: entry.server,
          }),
          "server_unavailable",
        );
      }

      let raw: CallToolResult;
      try {
        raw = await backend.callTool(entry.tool, args, ctx.caller, ctx.signal);
      } catch (e) {
        const error = e as Error & { code?: number };
        this.audit.write({
          ...line,
          decision: "allow",
          status: error.code === ERR.TIMEOUT ? "timeout" : "error",
          cancelled: ctx.signal?.aborted === true ? true : undefined,
          dur_ms: Date.now() - started,
          error: { code: error.code ?? -32603, message: this.guard.redactText(error.message) },
        });
        throw error;
      }

      // 6. guard-out: redact, then cap.
      const { result, bytes, truncated } = this.guard.capResult(this.guard.redact(raw));

      // 7. audit — exactly one line, whatever happened.
      this.audit.write({
        ...line,
        decision: "allow",
        status: "ok",
        dur_ms: Date.now() - started,
        result_bytes: bytes,
        truncated,
        ...this.audit.resultFields(result),
      });
      return result;
    } finally {
      // 8. release, always.
      limiter?.release();
    }
  }

  async readResource(ctx: CallContext, uri: string): Promise<ReadResourceResult> {
    const target = this.#resource(ctx, uri);
    return this.#audited({ ...this.#line(ctx, "resources/read"), server: target.server, tool: uri }, () =>
      target.backend.readResource(target.original, ctx.signal),
    );
  }

  async getPrompt(
    ctx: CallContext,
    exposed: string,
    args: Record<string, string> | undefined,
  ): Promise<GetPromptResult> {
    const canonical = this.#aliases.get(ctx.profile)?.get(exposed) ?? exposed;
    const entry = this.pool.catalog.getPrompt(canonical);
    const line = { ...this.#line(ctx, "prompts/get"), exposed_as: exposed };
    if (!entry) {
      return this.#refuse(line, new McpError(ErrorCode.MethodNotFound, `unknown prompt "${exposed}"`));
    }

    const decision = this.#decideNamed(ctx.profile, entry.canonical, entry.server);
    if (!decision.allow) {
      const code = decision.reason === "server_unavailable" ? ERR.BACKEND_DOWN : ERR.POLICY;
      return this.#refuse(
        { ...line, server: entry.server, tool: entry.name, decision: decision.reason },
        gwError(code, `"${exposed}" is not available: ${decision.reason}`, {
          reason: decision.reason,
          profile: ctx.profile,
          server: entry.server,
        }),
      );
    }

    const backend = this.pool.backends.get(entry.server)!;
    return this.#audited({ ...line, server: entry.server, tool: entry.name }, () =>
      backend.getPrompt(entry.name, args, ctx.signal),
    );
  }

  /** Subscribes the backend once, however many sessions are watching the same resource. */
  async subscribe(ctx: CallContext, uri: string): Promise<void> {
    const target = this.#resource(ctx, uri);
    const watchers = this.#watchers.get(uri) ?? new Set<string>();
    const first = watchers.size === 0;
    watchers.add(ctx.session ?? "");
    this.#watchers.set(uri, watchers);

    if (first) {
      await this.#audited(
        { ...this.#line(ctx, "resources/subscribe"), server: target.server, tool: uri },
        () => target.backend.subscribe(target.original),
      );
    }
  }

  /** Unsubscribes the backend only once nobody is left watching. */
  async unsubscribe(ctx: CallContext, uri: string): Promise<void> {
    const watchers = this.#watchers.get(uri);
    if (!watchers?.delete(ctx.session ?? "")) return;
    if (watchers.size > 0) return;

    this.#watchers.delete(uri);
    const target = this.#resource(ctx, uri);
    await this.#audited(
      { ...this.#line(ctx, "resources/unsubscribe"), server: target.server, tool: uri },
      () => target.backend.unsubscribe(target.original),
    );
  }

  /** Which sessions asked to hear about this resource. */
  watchersOf(uri: string): string[] {
    return [...(this.#watchers.get(uri) ?? [])];
  }

  /** A closing session stops watching everything, releasing backend subscriptions with it. */
  dropSession(sessionId: string, ctx: CallContext): void {
    for (const [uri, watchers] of [...this.#watchers]) {
      if (!watchers.has(sessionId)) continue;
      void this.unsubscribe({ ...ctx, session: sessionId }, uri).catch(() => {});
    }
  }

  async complete(ctx: CallContext, params: CompleteRequest["params"]): Promise<CompleteResult> {
    const line = this.#line(ctx, "completion/complete");

    if (params.ref.type === "ref/prompt") {
      const entry = this.pool.catalog.getPrompt(
        this.#aliases.get(ctx.profile)?.get(params.ref.name) ?? params.ref.name,
      );
      if (!entry || !this.#decideNamed(ctx.profile, entry.canonical, entry.server).allow) {
        return this.#refuse(line, new McpError(ErrorCode.MethodNotFound, "unknown prompt"));
      }
      const backend = this.pool.backends.get(entry.server)!;
      return this.#audited({ ...line, server: entry.server, tool: entry.name }, () =>
        backend.complete({ ...params, ref: { type: "ref/prompt", name: entry.name } }, ctx.signal),
      );
    }

    const target = this.#resource(ctx, params.ref.uri);
    return this.#audited({ ...line, server: target.server, tool: params.ref.uri }, () =>
      target.backend.complete(
        { ...params, ref: { type: "ref/resource", uri: target.original } },
        ctx.signal,
      ),
    );
  }

  /** Resolve a namespaced URI to its backend, refusing anything this profile cannot reach. */
  #resource(ctx: CallContext, uri: string): { backend: Backend; server: string; original: string } {
    const parsed = parseUri(uri);
    const backend = parsed ? this.pool.backends.get(parsed.server) : undefined;
    if (!parsed || !backend) {
      throw new McpError(ErrorCode.InvalidParams, `not a gateway resource URI: "${uri}"`);
    }
    if (!reaches(this.config.profiles[ctx.profile], parsed.server)) {
      throw gwError(ERR.POLICY, `"${uri}" is not available: server_not_in_profile`, {
        reason: "server_not_in_profile",
        profile: ctx.profile,
        server: parsed.server,
      });
    }
    return { backend, server: parsed.server, original: parsed.original };
  }

  #line(ctx: CallContext, method: string): AuditInput {
    return { method, session: ctx.session, profile: ctx.profile, client: ctx.client };
  }

  /** One audit line per proxied request, whatever happened to it (SPEC 7). */
  async #audited<T>(line: AuditInput, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await run();
      this.audit.write({ ...line, decision: "allow", status: "ok", dur_ms: Date.now() - started });
      return result;
    } catch (e) {
      const error = e as Error & { code?: number };
      this.audit.write({
        ...line,
        decision: line.decision ?? "allow",
        status: error.code === ERR.TIMEOUT ? "timeout" : "error",
        dur_ms: Date.now() - started,
        error: { code: error.code ?? -32603, message: this.guard.redactText(error.message) },
      });
      throw error;
    }
  }

  #refuse(line: AuditInput, error: Error & { code?: number }): never {
    this.audit.write({
      ...line,
      status: "denied",
      error: { code: error.code ?? -32603, message: this.guard.redactText(error.message) },
    });
    throw error;
  }

  /** The tool decision, for things that are named like tools but are not in the tool catalog. */
  #decideNamed(profileName: string, canonical: string, server: string): Decision {
    return decide(canonical, {
      profile: this.config.profiles[profileName],
      serverState: this.pool.backends.get(server)?.state,
      drifted: false, // pinning covers tools; a prompt has no inputSchema to pin
      onDrift: this.config.guard.on_drift,
    });
  }

  #decide(profileName: string, entry: CatalogEntry): Decision {
    return decide(entry.canonical, {
      profile: this.config.profiles[profileName],
      serverState: this.pool.backends.get(entry.server)?.state,
      drifted: this.guard.isDrifted(entry.server, entry.tool),
      onDrift: this.config.guard.on_drift,
    });
  }
}
