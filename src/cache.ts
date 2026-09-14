import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { globMatch } from "./glob.js";
import { canonicalJson, hashTool } from "./guard.js";

/**
 * Results of the tools a server's `cache.tools` names, for `ttl_ms` (ROADMAP Phase 8). Stored
 * after redaction and the size cap, so a hit is exactly what a miss would have returned.
 *
 * The key includes the tool's hash, so a drifted or changed tool never answers from a result its
 * old definition produced. Shared across sessions and profiles: policy has already run for the
 * caller by the time the cache is consulted, and the same arguments to the same tool are the same
 * question whoever asks.
 *
 * ponytail: in memory, evicted oldest-first by insertion. Upgrade: true LRU if hot keys get evicted.
 */
export class ResponseCache {
  readonly #entries = new Map<string, { result: CallToolResult; expires: number }>();

  constructor(
    private config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  /** A reload may change which tools are cached, or for how long: start clean. */
  reload(config: Config): void {
    this.config = config;
    this.#entries.clear();
  }

  /** The key for this call, or undefined when its server does not cache this tool. */
  keyFor(server: string, tool: string, def: Tool, args: unknown): string | undefined {
    const cache = this.config.servers[server]?.cache;
    if (!cache?.tools.some((glob) => globMatch(glob, tool))) return undefined;
    return [server, tool, hashTool(def), canonicalJson(args ?? {})].join("\n");
  }

  get(key: string): CallToolResult | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expires > this.now()) return hit.result;
    this.#entries.delete(key);
    return undefined;
  }

  set(key: string, server: string, result: CallToolResult): void {
    const cache = this.config.servers[server]?.cache;
    // An error is an answer about this moment, not about the question.
    if (!cache || result.isError) return;
    this.#entries.delete(key);
    this.#entries.set(key, { result, expires: this.now() + cache.ttl_ms });
    const mine = [...this.#entries.keys()].filter((k) => k.startsWith(`${server}\n`));
    for (const stale of mine.slice(0, Math.max(0, mine.length - cache.max_entries))) {
      this.#entries.delete(stale);
    }
  }
}
