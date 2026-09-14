import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  ElicitResult,
  GetPromptResult,
  Progress,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditInput, AuditLine, AuditLog } from "./audit.js";
import type { Backend, ReverseTarget } from "./backend.js";
import { parseUri, type CatalogEntry, type PromptEntry } from "./catalog.js";
import type { Config } from "./config.js";
import { ERR, gwError } from "./errors.js";
import type { Guard, Pinned } from "./guard.js";
import { decide, needsApproval, reaches, type Decision } from "./policy.js";
import type { Pool } from "./pool.js";
import { ResponseCache } from "./cache.js";
import { limitersFor, restoreLimiters, saveLimiters, type Limiters } from "./ratelimit.js";

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
  /** Where the backend's progress for this call goes (SPEC 4.2). */
  onprogress?: (progress: Progress) => void;
  /** Whether this client declared it can answer `elicitation/create` — what approval needs. */
  canElicit?: boolean;
}

/** SPEC §3.3: under `on_drift: warn` a changed tool is still listed, but flagged. */
const WARN_PREFIX = "⚠ [unverified change] ";
/** The same, for content the scan flagged under `on_suspicious: warn`. */
const SUSPICIOUS_PREFIX = "⚠ [suspicious content] ";

/** An approval prompt shows the arguments; past this they are cut, not the prompt refused. */
const APPROVAL_ARGS_CHARS = 2000;

/**
 * SPEC §5, in order: resolve → policy → limit → guard-in → dispatch → guard-out → audit →
 * release. Policy runs before the limiter so a denied call burns no budget, and the release is
 * in a `finally` so a throwing backend cannot leak a slot.
 */
export class Pipeline {
  #limiters: Limiters;
  readonly #cache: ResponseCache;
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
    this.#cache = new ResponseCache(config, now);
    for (const [name, profile] of Object.entries(config.profiles)) {
      const byAlias = new Map<string, string>();
      for (const [canonical, alias] of Object.entries(profile.rename)) byAlias.set(alias, canonical);
      this.#aliases.set(name, byAlias);
    }
  }

  /**
   * Calls currently dispatched to a backend, across every profile — what a drain waits for.
   * Profile limiters only: every call holds exactly one of those, and some a server's as well.
   */
  get inflight(): number {
    let total = 0;
    for (const limiter of this.#limiters.profiles.values()) total += limiter.inflight;
    return total;
  }

  /** Graceful shutdown: keep the buckets, so a restart is not a way to refill them. */
  saveLimits(dir: string): void {
    saveLimiters(dir, this.#limiters);
  }

  restoreLimits(dir: string): void {
    restoreLimiters(dir, this.#limiters);
  }

  /** SIGHUP: new profiles, globs, renames, limits and cache rules take effect on the next call. */
  reload(config: Config): void {
    this.#limiters = limitersFor(config, this.now, this.#limiters);
    this.#cache.reload(config);
    this.config = config;
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
      .map(({ entry, exposed }) => ({
        ...entry.def,
        name: exposed,
        description: this.#flagged(entry.def.description, entry.server, entry.tool, "tool"),
      }));
  }

  /** Prompts are named like tools, so the same allow/deny decision applies to them. */
  visiblePrompts(profileName: string): Prompt[] {
    const profile = this.config.profiles[profileName];
    return this.pool.catalog
      .allPrompts()
      .filter((entry) => this.#decidePrompt(profileName, entry).allow)
      .map((entry) => ({
        ...entry.def,
        name: profile?.rename[entry.canonical] ?? entry.canonical,
        description: this.#flagged(entry.def.description, entry.server, entry.name, "prompt"),
      }));
  }

  /** The approve glob a tool matches in a profile, if any — for `mcpgw list`. */
  approvalRule(profileName: string, canonical: string): string | undefined {
    return needsApproval(this.config.profiles[profileName], canonical);
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
    const held = this.#acquire(ctx.profile, entry.server);
    if (held instanceof McpError) return fail(held, "rate_limited");

    try {
      // 4. guard-in: the arguments must fit the schema the backend published.
      const invalid = this.guard.validateArgs(canonical, entry.def, args);
      if (invalid) {
        return fail(
          new McpError(ErrorCode.InvalidParams, `invalid arguments for "${exposed}": ${invalid}`),
          "allow",
        );
      }

      // 4¼. approval: a human says yes in the calling client, or the call does not happen. Ahead
      //     of the cache, so a cached answer never stands in for a yes.
      const rule = needsApproval(this.config.profiles[ctx.profile], canonical);
      if (rule) {
        const refusal = await this.#approve(ctx, exposed, canonical, rule, args);
        if (refusal) return fail(refusal.error, refusal.decision);
        line.approved = true;
      }

      // 4½. cache: after policy and validation, so a hit can never bypass either. It has spent
      //     rate budget by now — ponytail: move the lookup before step 3 if that ever matters.
      const cacheKey = this.#cache.keyFor(entry.server, entry.tool, entry.def, args);
      const cached = cacheKey === undefined ? undefined : this.#cache.get(cacheKey);
      if (cached) {
        this.audit.write({
          ...line,
          decision: "allow",
          status: "ok",
          cached: true,
          dur_ms: Date.now() - started,
          result_bytes: Buffer.byteLength(JSON.stringify(cached)),
          truncated: false,
          ...this.audit.resultFields(cached),
        });
        return cached;
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
        raw = await backend.callTool(entry.tool, args, ctx);
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
      if (cacheKey !== undefined) this.#cache.set(cacheKey, entry.server, result);

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
      held.release();
    }
  }

  async readResource(ctx: CallContext, uri: string): Promise<ReadResourceResult> {
    const target = this.#resource(ctx, "resources/read", uri);
    return this.#metered(
      ctx,
      { ...this.#line(ctx, "resources/read"), server: target.server, tool: uri },
      async () => {
        const raw = await target.backend.readResource(target.original, ctx);
        return this.guard.capContents(raw).result;
      },
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

    const decision = this.#decidePrompt(ctx.profile, entry);
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
    return this.#metered(ctx, { ...line, server: entry.server, tool: entry.name }, async () =>
      this.guard.capPrompt(await backend.getPrompt(entry.name, args, ctx)).result,
    );
  }

  /** Subscribes the backend once, however many sessions are watching the same resource. */
  async subscribe(ctx: CallContext, uri: string): Promise<void> {
    const target = this.#resource(ctx, "resources/subscribe", uri);
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
    const target = this.#resource(ctx, "resources/unsubscribe", uri);
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
      if (!entry || !this.#decidePrompt(ctx.profile, entry).allow) {
        return this.#refuse(line, new McpError(ErrorCode.MethodNotFound, "unknown prompt"));
      }
      const backend = this.pool.backends.get(entry.server)!;
      const ref = { type: "ref/prompt" as const, name: entry.name };
      return this.#metered(ctx, { ...line, server: entry.server, tool: entry.name }, async () =>
        this.guard.capCompletion(await backend.complete({ ...params, ref }, ctx)).result,
      );
    }

    const target = this.#resource(ctx, "completion/complete", params.ref.uri);
    const ref = { type: "ref/resource" as const, uri: target.original };
    return this.#metered(ctx, { ...line, server: target.server, tool: params.ref.uri }, async () =>
      this.guard.capCompletion(await target.backend.complete({ ...params, ref }, ctx)).result,
    );
  }

  /**
   * Resolve a namespaced URI to its backend, refusing anything this profile cannot reach. A
   * refusal is still a request, so it gets its audit line like any other (G4).
   */
  #resource(
    ctx: CallContext,
    method: string,
    uri: string,
  ): { backend: Backend; server: string; original: string } {
    const line = { ...this.#line(ctx, method), tool: uri };
    const parsed = parseUri(uri);
    const backend = parsed ? this.pool.backends.get(parsed.server) : undefined;
    if (!parsed || !backend) {
      return this.#refuse(
        line,
        new McpError(ErrorCode.InvalidParams, `not a gateway resource URI: "${uri}"`),
      );
    }
    if (!reaches(this.config.profiles[ctx.profile], parsed.server)) {
      return this.#refuse(
        { ...line, server: parsed.server, decision: "server_not_in_profile" },
        gwError(ERR.POLICY, `"${uri}" is not available: server_not_in_profile`, {
          reason: "server_not_in_profile",
          profile: ctx.profile,
          server: parsed.server,
        }),
      );
    }
    return { backend, server: parsed.server, original: parsed.original };
  }

  #line(ctx: CallContext, method: string): AuditInput {
    return { method, session: ctx.session, profile: ctx.profile, client: ctx.client };
  }

  /**
   * The limiter for the non-tool methods that still make a backend do work. A profile's rpm is
   * its whole budget, not its tool-call budget — the limit exists to protect the backend, and a
   * `resources/read` loop costs it exactly as much as a `tools/call` loop.
   *
   * `subscribe`/`unsubscribe` are deliberately not metered: they are bookkeeping, and refusing
   * an unsubscribe would strand the backend subscription the session had already released.
   */
  async #metered<T>(ctx: CallContext, line: AuditInput, run: () => Promise<T>): Promise<T> {
    const held = this.#acquire(ctx.profile, line.server ?? "");
    if (held instanceof McpError) return this.#refuse({ ...line, decision: "rate_limited" }, held);
    try {
      return await this.#audited(line, run);
    } finally {
      held.release();
    }
  }

  /**
   * SPEC §8: the profile's budget, then the server's. Both are held or neither is — a server
   * refusal hands the profile its slot back.
   *
   * ponytail: but not its rpm token, since a bucket has no un-take. A call refused by its server
   * still costs its profile one request per minute.
   */
  #acquire(profile: string, server: string): { release(): void } | McpError {
    const byProfile = this.#limiters.profiles.get(profile);
    const byServer = this.#limiters.servers.get(server);
    const first = byProfile?.acquire() ?? { ok: true as const };
    if (!first.ok) {
      return gwError(ERR.RATE_LIMITED, `profile "${profile}" is over its limit`, {
        reason: "rate_limited",
        profile,
        retry_after_ms: first.retryAfterMs,
      });
    }
    const second = byServer?.acquire() ?? { ok: true as const };
    if (!second.ok) {
      byProfile?.release();
      return gwError(ERR.RATE_LIMITED, `server "${server}" is over its limit`, {
        reason: "rate_limited",
        profile,
        server,
        retry_after_ms: second.retryAfterMs,
      });
    }
    return {
      release: () => {
        byServer?.release();
        byProfile?.release();
      },
    };
  }

  /** One audit line per proxied request, whatever happened to it (SPEC 7). */
  async #audited<T>(line: AuditInput, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      // FR-16 applies to everything the gateway forwards, not only to tool results.
      const result = this.guard.redact(await run());
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

  /**
   * Puts the call to the human through the client that made it (`elicitation/create`). Fails
   * closed: a client that cannot elicit, a decline, a dismissal, a timeout and a dropped
   * connection all refuse. This is the gateway's own request to its own session, so unlike a
   * backend's reverse request there is nothing to correlate.
   *
   * ponytail: the wait holds the call's rate-limit slots. That is the brake working, but a human
   * who walks away holds a slot for up to `approval_timeout_ms`.
   */
  async #approve(
    ctx: CallContext,
    exposed: string,
    canonical: string,
    rule: string,
    args: Record<string, unknown> | undefined,
  ): Promise<{ error: McpError; decision: "approval_denied" | "approval_unavailable" } | undefined> {
    const refuse = (decision: "approval_denied" | "approval_unavailable", why: string) => ({
      decision,
      error: gwError(ERR.POLICY, `"${exposed}" needs approval: ${why}`, {
        reason: decision,
        profile: ctx.profile,
        tool: canonical,
      }),
    });
    if (!ctx.canElicit || !ctx.caller) {
      return refuse("approval_unavailable", "this client cannot be asked (no elicitation support)");
    }

    // Redacted: the prompt is shown to a person, and may be screenshotted or logged by the client.
    const shown = JSON.stringify(this.guard.redact(args ?? {}), null, 2);
    const message = [
      `Allow ${exposed}${exposed === canonical ? "" : ` (${canonical})`}?`,
      `Profile "${ctx.profile}" requires approval for it (approve: ${rule}).`,
      "",
      shown.length > APPROVAL_ARGS_CHARS ? `${shown.slice(0, APPROVAL_ARGS_CHARS)}\n… (truncated)` : shown,
    ].join("\n");

    try {
      const reply = (await ctx.caller.elicitInput(
        {
          message,
          requestedSchema: {
            type: "object",
            properties: { approve: { type: "boolean", title: "Allow this call" } },
            required: ["approve"],
          },
        },
        { timeout: this.config.guard.approval_timeout_ms, signal: ctx.signal },
      )) as ElicitResult;
      if (reply.action === "accept" && reply.content?.approve === true) return undefined;
      return refuse("approval_denied", reply.action === "accept" ? "not approved" : `${reply.action}ed`);
    } catch (e) {
      return refuse("approval_denied", `no answer: ${(e as Error).message}`);
    }
  }

  /** The tool decision, applied to a prompt: they are named alike, and pinned alike. */
  #decidePrompt(profileName: string, entry: PromptEntry): Decision {
    return this.#facts(profileName, entry.canonical, entry.server, entry.name, "prompt");
  }

  #decide(profileName: string, entry: CatalogEntry): Decision {
    return this.#facts(profileName, entry.canonical, entry.server, entry.tool, "tool");
  }

  #facts(profile: string, canonical: string, server: string, name: string, of: Pinned): Decision {
    return decide(canonical, {
      profile: this.config.profiles[profile],
      serverState: this.pool.backends.get(server)?.state,
      drifted: this.guard.isDrifted(server, name, of),
      onDrift: this.config.guard.on_drift,
      suspicious: this.guard.isSuspicious(server, name, of),
      onSuspicious: this.config.guard.on_suspicious,
    });
  }

  /** SPEC §3.3: what a listing says about an allowed tool or prompt it still has doubts about. */
  #flagged(description: string | undefined, server: string, name: string, of: Pinned) {
    let flags = "";
    if (this.guard.isDrifted(server, name, of)) flags += WARN_PREFIX;
    if (this.guard.isSuspicious(server, name, of)) flags += SUSPICIOUS_PREFIX;
    return flags ? flags + (description ?? "") : description;
  }
}
