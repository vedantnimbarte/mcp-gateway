import { Backend } from "./backend.js";
import { Catalog } from "./catalog.js";
import type { Config, ServerConfig } from "./config.js";
import { canonicalJson, type Guard } from "./guard.js";

/**
 * Every backend, connected once and shared by every session (PRD G2). Owns the merged catalog
 * and republishes it whenever a backend arrives, dies or changes its tools.
 */
export class Pool {
  readonly backends = new Map<string, Backend>();
  catalog = Catalog.empty();
  /** Set by the gateway so sessions can be told their view changed (ARCHITECTURE §3.3). */
  onCatalogChange?: () => void;

  #config: Config;

  constructor(
    config: Config,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {},
    private readonly guard?: Guard,
  ) {
    this.#config = config;
    for (const name of Object.keys(config.servers)) this.#add(name, config);
  }

  #add(name: string, config: Config): Backend {
    const backend = new Backend(name, config.servers[name]!, config.defaults);
    backend.onChange = () => this.#rebuild();
    backend.onEvent = this.log;
    this.backends.set(name, backend);
    return backend;
  }

  /**
   * SIGHUP (NFR-8): only a server whose definition changed is restarted. Everything else — its
   * connection, its child process, the sessions using it — is left alone.
   */
  async reload(config: Config): Promise<void> {
    const same = (a: ServerConfig | undefined, b: ServerConfig | undefined) =>
      a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
    const previous = this.#config;
    this.#config = config;

    const starting: Promise<void>[] = [];
    for (const name of new Set([...Object.keys(previous.servers), ...Object.keys(config.servers)])) {
      if (same(previous.servers[name], config.servers[name])) continue;

      const existing = this.backends.get(name);
      if (existing) {
        this.log("backend_stopping", { server: name, reason: "config changed" });
        await existing.close();
        this.backends.delete(name);
      }
      if (config.servers[name]) starting.push(this.#add(name, config).start().catch(() => {}));
    }

    this.#rebuild();
    await Promise.all(starting);
  }

  /** In parallel, each with its own timeout: a slow backend never blocks its peers (NFR-6). */
  async start(): Promise<void> {
    await Promise.all([...this.backends.values()].map((b) => b.start().catch(() => {})));
  }

  #rebuild(): void {
    // Re-hash before the catalog is published, so a drifted tool is already blocked by the time
    // any session is told the listing changed.
    for (const backend of this.backends.values()) {
      if (backend.state !== "up") continue;
      for (const change of this.guard?.review(backend.name, backend.tools) ?? []) {
        this.log(change.kind, { ...change, kind: undefined });
      }
    }
    this.catalog = Catalog.build(this.backends.values());
    this.onCatalogChange?.();
  }

  async close(): Promise<void> {
    await Promise.all([...this.backends.values()].map((b) => b.close()));
    this.catalog = Catalog.empty();
  }
}
