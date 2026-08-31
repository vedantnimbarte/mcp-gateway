import { Backend } from "./backend.js";
import { Catalog } from "./catalog.js";
import type { Config } from "./config.js";

/**
 * Every backend, connected once and shared by every session (PRD G2). Owns the merged catalog
 * and republishes it whenever a backend arrives, dies or changes its tools.
 */
export class Pool {
  readonly backends = new Map<string, Backend>();
  catalog = Catalog.empty();
  /** Set by the gateway so sessions can be told their view changed (ARCHITECTURE §3.3). */
  onCatalogChange?: () => void;

  constructor(
    config: Config,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {},
  ) {
    for (const [name, cfg] of Object.entries(config.servers)) {
      const backend = new Backend(name, cfg, config.defaults);
      backend.onChange = () => this.#rebuild();
      backend.onEvent = this.log;
      this.backends.set(name, backend);
    }
  }

  /** In parallel, each with its own timeout: a slow backend never blocks its peers (NFR-6). */
  async start(): Promise<void> {
    await Promise.all([...this.backends.values()].map((b) => b.start().catch(() => {})));
  }

  #rebuild(): void {
    this.catalog = Catalog.build(this.backends.values());
    this.onCatalogChange?.();
  }

  async close(): Promise<void> {
    await Promise.all([...this.backends.values()].map((b) => b.close()));
    this.catalog = Catalog.empty();
  }
}
