import { createHash } from "node:crypto";
import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Backend } from "./backend.js";

/** SPEC §2. */
const MAX_NAME = 128;
const TRUNCATE_TO = 120;
/** Resources are addressed by URI, so they get a scheme rather than a name prefix. */
export const RESOURCE_SCHEME = "mcpgw://";

export interface CatalogEntry {
  /** `<server>__<tool>`, sanitized and length-capped. */
  canonical: string;
  server: string;
  /** The name the backend knows it by, unsanitized. */
  tool: string;
  /** The tool definition as exposed, i.e. renamed to `canonical`. */
  def: Tool;
}

export interface PromptEntry {
  canonical: string;
  server: string;
  name: string;
  def: Prompt;
}

export interface ResourceEntry {
  /** `mcpgw://<server>/<original-uri>`. */
  uri: string;
  server: string;
  /** The URI the backend knows it by. */
  original: string;
  def: Resource | ResourceTemplate;
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

/** SPEC §2: `mcpgw://<server>/<original-uri>`, kept whole so any URI shape survives a round trip. */
export function namespaceUri(server: string, uri: string): string {
  return `${RESOURCE_SCHEME}${server}/${uri}`;
}

/** Server keys cannot contain `/`, so the first one after the scheme ends the server name. */
export function parseUri(uri: string): { server: string; original: string } | undefined {
  if (!uri.startsWith(RESOURCE_SCHEME)) return undefined;
  const rest = uri.slice(RESOURCE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return { server: rest.slice(0, slash), original: rest.slice(slash + 1) };
}

/** The merged, namespaced view of every UP backend. Rebuilt on connect, loss and list_changed. */
export class Catalog {
  private constructor(
    private readonly entries: Map<string, CatalogEntry>,
    private readonly prompts: Map<string, PromptEntry>,
    private readonly resources: Map<string, ResourceEntry>,
    private readonly templates: Map<string, ResourceEntry>,
  ) {}

  static build(backends: Iterable<Backend>): Catalog {
    const entries = new Map<string, CatalogEntry>();
    const prompts = new Map<string, PromptEntry>();
    const resources = new Map<string, ResourceEntry>();
    const templates = new Map<string, ResourceEntry>();

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

      for (const prompt of backend.prompts) {
        const canonical = canonicalName(backend.name, prompt.name, new Set(prompts.keys()));
        prompts.set(canonical, {
          canonical,
          server: backend.name,
          name: prompt.name,
          def: { ...prompt, name: canonical },
        });
      }

      for (const resource of backend.resources) {
        const uri = namespaceUri(backend.name, resource.uri);
        resources.set(uri, {
          uri,
          server: backend.name,
          original: resource.uri,
          def: { ...resource, uri },
        });
      }

      for (const template of backend.resourceTemplates) {
        const uri = namespaceUri(backend.name, template.uriTemplate);
        templates.set(uri, {
          uri,
          server: backend.name,
          original: template.uriTemplate,
          def: { ...template, uriTemplate: uri },
        });
      }
    }

    return new Catalog(entries, prompts, resources, templates);
  }

  static empty(): Catalog {
    return new Catalog(new Map(), new Map(), new Map(), new Map());
  }

  get(canonical: string): CatalogEntry | undefined {
    return this.entries.get(canonical);
  }

  getPrompt(canonical: string): PromptEntry | undefined {
    return this.prompts.get(canonical);
  }

  /** Concrete resources only; a templated URI is matched by its owning server, not by lookup. */
  getResource(uri: string): ResourceEntry | undefined {
    return this.resources.get(uri);
  }

  /** Unfiltered. Which of these a profile may see is policy's decision, not the catalog's. */
  all(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  allPrompts(): PromptEntry[] {
    return [...this.prompts.values()];
  }

  allResources(): ResourceEntry[] {
    return [...this.resources.values()];
  }

  allTemplates(): ResourceEntry[] {
    return [...this.templates.values()];
  }
}
