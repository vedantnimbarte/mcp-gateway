import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/index.js";
import type { CallToolResult, ReadResourceResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { compileRedact, type Config } from "./config.js";

export const LOCKFILE = "tools.lock.json";

interface Pin {
  hash: string;
  seen: string;
  /**
   * Not in SPEC §6.2, which stores only the hash — but a hash cannot be diffed. Without the
   * pinned text, `mcpgw pin` could say a description changed and never show you into what.
   */
  description?: string;
}

interface Lockfile {
  version: 1;
  pinned_at: string;
  servers: Record<string, Record<string, Pin>>;
}

/** A payload after the size cap, with what it cost. */
export interface Capped<T> {
  result: T;
  bytes: number;
  truncated: boolean;
}

export type Change =
  | { kind: "pinned"; server: string; tool: string; hash: string }
  | { kind: "drift"; server: string; tool: string; from: string; to: string; diff: string }
  | { kind: "removed"; server: string; tool: string };

/** Recursively key-sorted JSON. Backends do not promise key order; without this every restart looks like drift. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sorted(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

/** SPEC §6.1. */
export function hashTool(tool: Tool): string {
  const material = canonicalJson({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

// Backend tool names are unsanitized here, so the separator must be one they cannot contain.
const key = (server: string, tool: string) => [server, tool].join(String.fromCharCode(0));

/** A description diff a human can read in a terminal, without pulling in a diff library. */
function describeChange(before: Pin, after: Tool): string {
  const oldDescription = before.description;
  const newDescription = after.description ?? "";
  if (oldDescription === undefined) {
    return `  (pinned before descriptions were recorded)\n+ ${newDescription || "(none)"}`;
  }
  if (oldDescription !== newDescription) {
    return `- ${oldDescription || "(none)"}\n+ ${newDescription || "(none)"}`;
  }
  return "  description unchanged; inputSchema changed";
}

/**
 * Tool pinning, redaction and size caps (FR-13..17). The threat is a backend quietly changing a
 * tool you already approved, so a changed hash blocks by default and is never accepted silently.
 */
export class Guard {
  #lock: Lockfile;
  #drifted = new Map<string, Change & { kind: "drift" }>();
  #removed = new Map<string, Change & { kind: "removed" }>();
  #patterns: RegExp[];
  #validators = new Map<string, { schema: string; validate: JsonSchemaValidator<unknown> }>();
  #ajv = new AjvJsonSchemaValidator();
  /** The current shape of each drifted tool, so `pin` can accept exactly what it showed you. */
  #shapes = new Map<string, Tool>();

  private constructor(
    private cfg: Config["guard"],
    private readonly lockPath: string,
    lock: Lockfile,
  ) {
    this.#lock = lock;
    this.#patterns = cfg.redact.map(compileRedact);
  }

  /** The lockfile lives beside the config it belongs to. */
  static load(config: Config, configPath: string): Guard {
    const lockPath = join(dirname(configPath), LOCKFILE);
    let lock: Lockfile = { version: 1, pinned_at: new Date().toISOString(), servers: {} };
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Lockfile;
      if (parsed.version === 1 && parsed.servers) lock = parsed;
    } catch {
      // No lockfile yet: everything is new, and everything gets auto-pinned on first sight.
    }
    return new Guard(config.guard, lockPath, lock);
  }

  /**
   * Re-hashes one backend's tools against the lockfile (SPEC §6.3). New tools are pinned on
   * sight; changed ones are marked drifted and stay that way until `mcpgw pin` accepts them.
   */
  review(server: string, tools: Tool[]): Change[] {
    if (!this.cfg.pin_tools) return [];

    const changes: Change[] = [];
    const pinned = (this.#lock.servers[server] ??= {});
    const now = new Date().toISOString();

    for (const tool of tools) {
      const k = key(server, tool.name);
      const hash = hashTool(tool);
      const previous = pinned[tool.name];

      if (!previous) {
        pinned[tool.name] = { hash, seen: now, description: tool.description ?? "" };
        this.#drifted.delete(k);
        changes.push({ kind: "pinned", server, tool: tool.name, hash });
        continue;
      }
      if (previous.hash === hash) {
        this.#drifted.delete(k);
        continue;
      }
      const drift: Change & { kind: "drift" } = {
        kind: "drift",
        server,
        tool: tool.name,
        from: previous.hash,
        to: hash,
        diff: describeChange(previous, tool),
      };
      this.#drifted.set(k, drift);
      this.#shapes.set(k, tool);
      changes.push(drift);
    }

    // Present in the lockfile but no longer offered. Recorded, not deleted: `mcpgw pin` decides.
    const live = new Set(tools.map((t) => t.name));
    for (const name of Object.keys(pinned)) {
      const k = key(server, name);
      if (live.has(name)) {
        this.#removed.delete(k);
        continue;
      }
      if (!this.#removed.has(k)) {
        const removal = { kind: "removed" as const, server, tool: name };
        this.#removed.set(k, removal);
        changes.push(removal);
      }
    }

    if (changes.some((c) => c.kind === "pinned")) this.save();
    return changes;
  }

  /** SIGHUP: new redaction patterns, caps and drift policy. Existing pins are untouched. */
  reload(config: Config): void {
    this.cfg = config.guard;
    this.#patterns = config.guard.redact.map(compileRedact);
  }

  isDrifted(server: string, tool: string): boolean {
    return this.#drifted.has(key(server, tool));
  }

  get blocking(): boolean {
    return this.cfg.on_drift === "block";
  }

  pending(server?: string): Change[] {
    const all = [...this.#drifted.values(), ...this.#removed.values()];
    return server ? all.filter((c) => c.server === server) : all;
  }

  /** `mcpgw pin`: accept every pending change and rewrite the lockfile. */
  accept(server?: string): Change[] {
    const accepted = this.pending(server);
    const now = new Date().toISOString();
    for (const change of accepted) {
      const k = key(change.server, change.tool);
      const tools = (this.#lock.servers[change.server] ??= {});
      if (change.kind === "drift") {
        tools[change.tool] = {
          hash: change.to,
          seen: now,
          description: this.#shapes.get(k)?.description ?? "",
        };
        this.#drifted.delete(k);
        this.#shapes.delete(k);
      } else if (change.kind === "removed") {
        delete tools[change.tool];
        this.#removed.delete(k);
      }
    }
    if (accepted.length > 0) this.save();
    return accepted;
  }

  save(): void {
    this.#lock.pinned_at = new Date().toISOString();
    writeFileSync(this.lockPath, `${JSON.stringify(this.#lock, null, 2)}\n`);
  }

  /**
   * SPEC §5 step 4. The backend validates too — this is the earlier, cheaper refusal, so a
   * schema this validator cannot compile is skipped rather than turned into a false rejection.
   */
  validateArgs(canonical: string, tool: Tool, args: unknown): string | undefined {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") return undefined;
    try {
      const shape = canonicalJson(schema);
      let cached = this.#validators.get(canonical);
      if (!cached || cached.schema !== shape) {
        cached = { schema: shape, validate: this.#ajv.getValidator(schema) };
        this.#validators.set(canonical, cached);
      }
      const result = cached.validate(args ?? {});
      return result.valid ? undefined : result.errorMessage;
    } catch {
      return undefined;
    }
  }

  /** FR-16. Applied to arguments, results and error messages before they leave the process. */
  redactText(text: string): string {
    let out = text;
    for (const pattern of this.#patterns) out = out.replace(pattern, "[redacted]");
    return out;
  }

  /**
   * ponytail: redacts each string in place, so a secret split across two separate strings is not
   * matched. Whole-payload scanning would catch it and would also corrupt the structure it spans.
   */
  redact<T>(value: T): T {
    if (this.#patterns.length === 0) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redactText(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  /** FR-17: never forward an unbounded payload; truncate with a marker instead. */
  capResult(result: CallToolResult): Capped<CallToolResult> {
    const content = [...(result.content ?? [])];
    const last = content.map((c) => c.type).lastIndexOf("text");
    const block = last < 0 ? undefined : (content[last] as { type: "text"; text: string });
    return this.#cap(
      result,
      block?.text,
      (text) => {
        const trimmed = [...content];
        trimmed[last] = { ...block!, text };
        return { ...result, content: trimmed };
      },
      (text) => ({ ...result, content: [{ type: "text" as const, text }] }),
    );
  }

  /**
   * The same cap for `resources/read`. A resource is fetched by URI rather than offered to a
   * model, but it is still an unbounded payload arriving from a backend (FR-17).
   */
  capContents(result: ReadResourceResult): Capped<ReadResourceResult> {
    const contents = [...(result.contents ?? [])];
    const last = contents.map((c) => "text" in c).lastIndexOf(true);
    const block = last < 0 ? undefined : (contents[last] as { uri: string; text: string });
    return this.#cap(
      result,
      block?.text,
      (text) => {
        const trimmed = [...contents];
        trimmed[last] = { ...block!, text };
        return { ...result, contents: trimmed };
      },
      (text) => ({ ...result, contents: [{ uri: contents[0]?.uri ?? "mcpgw:truncated", text }] }),
    );
  }

  /**
   * Shrinks whichever text block the caller nominated until the whole payload fits. Measured,
   * not predicted: JSON escaping makes the serialized size larger than the raw string by an
   * amount that depends on the content, so this shrinks until it actually fits rather than
   * computing a budget it cannot know.
   */
  #cap<T>(
    result: T,
    text: string | undefined,
    withText: (text: string) => T,
    replace: (text: string) => T,
  ): Capped<T> {
    const max = this.cfg.max_result_bytes;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes <= max) return { result, bytes, truncated: false };

    const marker = (omitted: number) => `

[truncated by mcp-gateway: ${omitted} bytes omitted]`;

    if (text === undefined) {
      // Nothing textual to trim — replace the payload rather than forward it.
      const capped = replace(marker(bytes).trim());
      return { result: capped, bytes: Buffer.byteLength(JSON.stringify(capped)), truncated: true };
    }

    const textBytes = Buffer.byteLength(text);
    let budget = Math.max(0, max - (bytes - textBytes));
    for (;;) {
      const kept = budget > 0 ? Buffer.from(text).subarray(0, budget).toString("utf8") : "";
      const capped = withText(kept + marker(textBytes - Buffer.byteLength(kept)));
      const size = Buffer.byteLength(JSON.stringify(capped));
      // With an empty payload the marker itself is the floor; it is bounded and worth keeping.
      if (size <= max || budget === 0) return { result: capped, bytes: size, truncated: true };
      budget = Math.max(0, budget - (size - max));
    }
  }
}
