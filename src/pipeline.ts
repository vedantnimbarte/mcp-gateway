import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AuditInput, AuditLine, AuditLog } from "./audit.js";
import type { ReverseTarget } from "./backend.js";
import type { CatalogEntry } from "./catalog.js";
import type { Config } from "./config.js";
import { ERR, gwError } from "./errors.js";
import type { Guard } from "./guard.js";
import { decide, type Decision } from "./policy.js";
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

  /** A stable fingerprint of a profile's visible set, for suppressing no-op notifications. */
  visibleFingerprint(profileName: string): string {
    return this.visibleTools(profileName)
      .map((t) => t.name)
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
        raw = await backend.callTool(entry.tool, args, ctx.caller);
      } catch (e) {
        const error = e as Error & { code?: number };
        this.audit.write({
          ...line,
          decision: "allow",
          status: error.code === ERR.TIMEOUT ? "timeout" : "error",
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

  #decide(profileName: string, entry: CatalogEntry): Decision {
    return decide(entry.canonical, {
      profile: this.config.profiles[profileName],
      serverState: this.pool.backends.get(entry.server)?.state,
      drifted: this.guard.isDrifted(entry.server, entry.tool),
      onDrift: this.config.guard.on_drift,
    });
  }
}
