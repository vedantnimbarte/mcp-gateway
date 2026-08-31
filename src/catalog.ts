import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Backend } from "./backend.js";

/** SPEC §2. */
const MAX_NAME = 128;
const TRUNCATE_TO = 120;

export interface CatalogEntry {
  /** `<server>__<tool>`, sanitized and length-capped. */
  canonical: string;
  server: string;
  /** The name the backend knows it by, unsanitized. */
  tool: string;
  /** The tool definition as exposed, i.e. renamed to `canonical`. */
  def: Tool;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const hash7 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 7);

/**
 * Names are deterministic and collision-free: sanitized, capped at 128, and disambiguated by a
 * hash of the *original* pair — two tool names that sanitize to the same string still differ.
 */
export function canonicalName(server: string, tool: string, taken: ReadonlySet<string>): string {
  const full = `${server}__${tool}`;
  const raw = `${sanitize(server)}__${sanitize(tool)}`;
  const name = raw.length > MAX_NAME ? `${raw.slice(0, TRUNCATE_TO)}_${hash7(full)}` : raw;
  return taken.has(name) ? `${name.slice(0, TRUNCATE_TO)}_${hash7(full)}` : name;
}

/** The merged, namespaced view of every UP backend. Rebuilt on connect, loss and list_changed. */
export class Catalog {
  private constructor(private readonly entries: Map<string, CatalogEntry>) {}

  static build(backends: Iterable<Backend>): Catalog {
    const entries = new Map<string, CatalogEntry>();
    for (const backend of backends) {
      if (backend.state !== "up") continue;
      for (const tool of backend.tools) {
        const canonical = canonicalName(backend.name, tool.name, new Set(entries.keys()));
        entries.set(canonical, {
          canonical,
          server: backend.name,
          tool: tool.name,
          def: { ...tool, name: canonical },
        });
      }
    }
    return new Catalog(entries);
  }

  static empty(): Catalog {
    return new Catalog(new Map());
  }

  get(canonical: string): CatalogEntry | undefined {
    return this.entries.get(canonical);
  }

  /** Unfiltered. Which of these a profile may see is policy's decision, not the catalog's. */
  all(): CatalogEntry[] {
    return [...this.entries.values()];
  }
}
