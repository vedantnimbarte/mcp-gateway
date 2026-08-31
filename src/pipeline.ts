import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ReverseTarget } from "./backend.js";
import type { CatalogEntry } from "./catalog.js";
import type { Config } from "./config.js";
import { ERR, gwError } from "./errors.js";
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

/**
 * SPEC §5: resolve → policy → limit → dispatch. Guard and audit are inserted in Phase 4;
 * the order of what is here is already the final one — a denied call must not consume
 * rate-limit budget, so policy is checked before the limiter.
 */
export class Pipeline {
  readonly #limiters: Map<string, Limiter>;
  /** alias → canonical, per profile. Renames are static, so this is built once. */
  readonly #aliases = new Map<string, Map<string, string>>();

  constructor(
    private readonly config: Config,
    private readonly pool: Pool,
    now?: () => number,
  ) {
    this.#limiters = limitersFor(config, now);
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
      .map((row) => ({ ...row.entry.def, name: row.exposed }));
  }

  /** A stable fingerprint of a profile's visible set, for suppressing no-op notifications. */
  visibleFingerprint(profileName: string): string {
    return this.visibleTools(profileName)
      .map((t) => t.name)
      .sort()
      .join(" ");
  }

  async callTool(
    profileName: string,
    exposed: string,
    args: Record<string, unknown> | undefined,
    caller?: ReverseTarget,
  ): Promise<CallToolResult> {
    // 1. resolve. An alias resolves to its canonical name; the canonical name always resolves
    //    to itself, and policy is evaluated on it either way, so a rename is never a bypass.
    const canonical = this.#aliases.get(profileName)?.get(exposed) ?? exposed;
    const entry = this.pool.catalog.get(canonical);
    if (!entry) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${exposed}"`);
    }

    // 2. policy
    const decision = this.#decide(profileName, entry);
    if (!decision.allow) {
      const code = decision.reason === "server_unavailable" ? ERR.BACKEND_DOWN : ERR.POLICY;
      throw gwError(code, `"${exposed}" is not available: ${decision.reason}`, {
        reason: decision.reason,
        profile: profileName,
        server: entry.server,
        tool: entry.tool,
      });
    }

    // 3. limit
    const limiter = this.#limiters.get(profileName);
    const grant = limiter?.acquire() ?? { ok: true as const };
    if (!grant.ok) {
      throw gwError(ERR.RATE_LIMITED, `profile "${profileName}" is over its limit`, {
        reason: "rate_limited",
        profile: profileName,
        retry_after_ms: grant.retryAfterMs,
      });
    }

    // 5. dispatch (4 guard-in and 6-7 guard-out/audit arrive in Phase 4)
    try {
      const backend = this.pool.backends.get(entry.server);
      if (!backend) {
        throw gwError(ERR.BACKEND_DOWN, `backend "${entry.server}" is gone`, {
          reason: "server_unavailable",
          server: entry.server,
        });
      }
      return await backend.callTool(entry.tool, args, caller);
    } finally {
      // 8. release, always.
      limiter?.release();
    }
  }

  #decide(profileName: string, entry: CatalogEntry): Decision {
    return decide(entry.canonical, {
      profile: this.config.profiles[profileName],
      serverState: this.pool.backends.get(entry.server)?.state,
      drifted: false, // Phase 4 supplies this from the lockfile
      onDrift: this.config.guard.on_drift,
    });
  }
}
