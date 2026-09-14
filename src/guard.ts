import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/index.js";
import type {
  CallToolResult,
  CompleteResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
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
  /** A human accepted this exact hash in `mcpgw pin` despite what the content scan found. */
  approved?: boolean;
}

interface Lockfile {
  version: 1;
  pinned_at: string;
  servers: Record<string, Record<string, Pin>>;
  /** Added after v1 shipped; a lockfile without it simply has no prompts pinned yet. */
  prompts?: Record<string, Record<string, Pin>>;
}

/** A payload after the size cap, with what it cost. */
export interface Capped<T> {
  result: T;
  bytes: number;
  truncated: boolean;
}

/** What is pinned: a tool, or a prompt. Changes to prompts carry `of: "prompt"`. */
export type Pinned = "tool" | "prompt";

type About = { server: string; tool: string; of?: "prompt" };
export type Change =
  | (About & { kind: "pinned"; hash: string })
  | (About & { kind: "drift"; from: string; to: string; diff: string })
  | (About & { kind: "removed" })
  | (About & { kind: "suspicious"; hash: string; findings: string[] });

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

const sha = (material: string) => `sha256:${createHash("sha256").update(material).digest("hex")}`;

/** SPEC §6.1. */
export function hashTool(tool: Tool): string {
  return sha(
    canonicalJson({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }),
  );
}

/** The prompt equivalent: what a prompt tells the model is its description and its arguments. */
export function hashPrompt(prompt: Prompt): string {
  return sha(
    canonicalJson({
      name: prompt.name,
      description: prompt.description ?? "",
      arguments: prompt.arguments ?? [],
    }),
  );
}

/** Every string in a value, however deeply nested: all of it reaches the model. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** One thing to pin, whatever it is. */
interface Subject {
  name: string;
  description: string;
  hash: string;
  /** The text the content scan reads. */
  text: string[];
}

const toolSubject = (t: Tool): Subject => ({
  name: t.name,
  description: t.description ?? "",
  hash: hashTool(t),
  text: strings({ title: t.title, description: t.description, inputSchema: t.inputSchema }),
});

const promptSubject = (p: Prompt): Subject => ({
  name: p.name,
  description: p.description ?? "",
  hash: hashPrompt(p),
  text: strings({ title: p.title, description: p.description, arguments: p.arguments }),
});

/**
 * Phrasings that have no business in a tool description, and are how injected instructions
 * usually read. A hit is a reason for a human to look, not proof of malice.
 *
 * ponytail: regex heuristics — they catch the lazy attacks and the copy-pasted ones, not a
 * determined author. Upgrade: a model-based review, if pinning plus these prove insufficient.
 */
const SUSPICIOUS: [label: string, pattern: RegExp][] = [
  [
    "instruction override",
    /\b(ignore|disregard|forget)\b.{0,20}\b(previous|prior|above|earlier)\b.{0,20}\b(instructions?|prompts?|rules)\b/i,
  ],
  ["concealment", /\bdo not\b.{0,20}\b(tell|inform|mention|reveal|show)\b.{0,40}\buser\b/i],
  ["hidden directive tag", /<\/?\s*(important|system|instructions?|secret)\s*>/i],
  ["invisible characters", /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/],
  ["credential path", /(\bid_rsa\b|\.ssh\/|\.aws\/credentials|\.netrc\b|\.env\b)/i],
  ["exfiltration", /\b(send|post|upload|exfiltrate|forward)\b.{0,80}https?:\/\//i],
];

/** The built-in patterns, then the operator's own `guard.scan_patterns`. */
function scanPatterns(cfg: Config["guard"]): [string, RegExp][] {
  const own = cfg.scan_patterns.map((source): [string, RegExp] => {
    const compiled = compileRedact(source);
    // Without the global flag: `exec` on a global regex is stateful across calls.
    return [`scan_patterns ${source}`, new RegExp(compiled.source, compiled.flags.replace("g", ""))];
  });
  return [...SUSPICIOUS, ...own];
}

function readLock(path: string): Lockfile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Lockfile;
    return parsed.version === 1 && parsed.servers ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Backend names are unsanitized here, so the separator must be one they cannot contain.
const key = (of: Pinned, server: string, name: string) => [of, server, name].join(String.fromCharCode(0));

/** A description diff a human can read in a terminal, without pulling in a diff library. */
function describeChange(before: Pin, after: Subject): string {
  const oldDescription = before.description;
  const newDescription = after.description;
  if (oldDescription === undefined) {
    return `  (pinned before descriptions were recorded)\n+ ${newDescription || "(none)"}`;
  }
  if (oldDescription !== newDescription) {
    return `- ${oldDescription || "(none)"}\n+ ${newDescription || "(none)"}`;
  }
  return "  description unchanged; schema or arguments changed";
}

/**
 * Tool and prompt pinning, content scanning, redaction and size caps (FR-13..17). The threat is a
 * backend quietly changing something you already approved, so a changed hash blocks by default
 * and is never accepted silently.
 */
export class Guard {
  #lock: Lockfile;
  #drifted = new Map<string, Change & { kind: "drift" }>();
  #removed = new Map<string, Change & { kind: "removed" }>();
  #suspicious = new Map<string, Change & { kind: "suspicious" }>();
  #patterns: RegExp[];
  #scanPatterns: [string, RegExp][];
  #validators = new Map<string, { schema: string; validate: JsonSchemaValidator<unknown> }>();
  #ajv = new AjvJsonSchemaValidator();
  /** The current description of each drifted subject, so `pin` accepts exactly what it showed. */
  #shapes = new Map<string, string>();

  private constructor(
    private cfg: Config["guard"],
    private readonly lockPath: string,
    lock: Lockfile,
  ) {
    this.#lock = lock;
    this.#patterns = cfg.redact.map(compileRedact);
    this.#scanPatterns = scanPatterns(cfg);
  }

  /** The lockfile lives beside the config it belongs to. */
  static load(config: Config, configPath: string): Guard {
    const lockPath = join(dirname(configPath), LOCKFILE);
    // No lockfile yet: everything is new, and everything gets auto-pinned on first sight.
    const empty: Lockfile = { version: 1, pinned_at: new Date().toISOString(), servers: {} };
    return new Guard(config.guard, lockPath, readLock(lockPath) ?? empty);
  }

  /**
   * Re-hashes one backend's tools against the lockfile (SPEC §6.3). New tools are pinned on
   * sight; changed ones are marked drifted and stay that way until `mcpgw pin` accepts them.
   */
  review(server: string, tools: Tool[]): Change[] {
    return this.#review("tool", server, tools.map(toolSubject));
  }

  /** The same, for prompts: a prompt rewritten after approval is as much a rug-pull as a tool. */
  reviewPrompts(server: string, prompts: Prompt[]): Change[] {
    return this.#review("prompt", server, prompts.map(promptSubject));
  }

  #section(of: Pinned): Record<string, Record<string, Pin>> {
    return of === "prompt" ? (this.#lock.prompts ??= {}) : this.#lock.servers;
  }

  #review(of: Pinned, server: string, subjects: Subject[]): Change[] {
    if (!this.cfg.pin_tools) return [];

    const changes: Change[] = [];
    const pinned = (this.#section(of)[server] ??= {});
    const now = new Date().toISOString();
    const about = (name: string): About => ({ server, tool: name, ...(of === "prompt" ? { of } : {}) });

    for (const subject of subjects) {
      const k = key(of, server, subject.name);
      const previous = pinned[subject.name];

      if (!previous) {
        pinned[subject.name] = { hash: subject.hash, seen: now, description: subject.description };
        this.#drifted.delete(k);
        changes.push({ kind: "pinned", ...about(subject.name), hash: subject.hash });
      } else if (previous.hash === subject.hash) {
        this.#drifted.delete(k);
      } else {
        const drift = {
          kind: "drift" as const,
          ...about(subject.name),
          from: previous.hash,
          to: subject.hash,
          diff: describeChange(previous, subject),
        };
        this.#drifted.set(k, drift);
        this.#shapes.set(k, subject.description);
        changes.push(drift);
      }

      // Scanned on every review, not only on first sight: a pin says "unchanged", not "vetted".
      // Only a human's `mcpgw pin` of this exact hash vouches for it.
      const findings = this.#scan(subject.text);
      const pin = pinned[subject.name];
      const vouched = pin?.approved === true && pin.hash === subject.hash;
      if (findings.length === 0 || vouched) {
        this.#suspicious.delete(k);
      } else if (this.#suspicious.get(k)?.hash !== subject.hash) {
        const flagged = { kind: "suspicious" as const, ...about(subject.name), hash: subject.hash, findings };
        this.#suspicious.set(k, flagged);
        changes.push(flagged);
      }
    }

    // Present in the lockfile but no longer offered. Recorded, not deleted: `mcpgw pin` decides.
    const live = new Set(subjects.map((s) => s.name));
    for (const name of Object.keys(pinned)) {
      const k = key(of, server, name);
      if (live.has(name)) {
        this.#removed.delete(k);
        continue;
      }
      if (!this.#removed.has(k)) {
        const removal = { kind: "removed" as const, ...about(name) };
        this.#removed.set(k, removal);
        changes.push(removal);
      }
    }

    if (changes.some((c) => c.kind === "pinned")) this.save();
    return changes;
  }

  #scan(text: string[]): string[] {
    const findings: string[] = [];
    for (const [label, pattern] of this.#scanPatterns) {
      for (const s of text) {
        const match = pattern.exec(s);
        if (!match) continue;
        // JSON.stringify makes invisible characters visible in the finding.
        findings.push(`${label}: ${JSON.stringify(match[0].slice(0, 80))}`);
        break;
      }
    }
    return findings;
  }

  /**
   * SIGHUP: new redaction patterns, caps and drift policy, and the lockfile as it is on disk now —
   * `mcpgw pin` accepts changes from its own process, and this is how the daemon hears about it.
   */
  reload(config: Config): void {
    this.cfg = config.guard;
    this.#patterns = config.guard.redact.map(compileRedact);
    this.#scanPatterns = scanPatterns(config.guard);

    // An unreadable lockfile keeps the pins in memory: treating it as empty would re-pin, and so
    // silently accept, every drifted tool.
    const lock = readLock(this.lockPath);
    if (!lock) return;
    this.#lock = lock;
    // Clear only what the lockfile now settles. Clearing everything and re-reviewing would leave
    // a window in which a drifted tool is callable.
    const pinOf = (c: About) => this.#section(c.of ?? "tool")[c.server]?.[c.tool];
    for (const [k, drift] of this.#drifted) {
      if (pinOf(drift)?.hash !== drift.to) continue;
      this.#drifted.delete(k);
      this.#shapes.delete(k);
    }
    for (const [k, removal] of this.#removed) {
      if (!pinOf(removal)) this.#removed.delete(k);
    }
    for (const [k, flagged] of this.#suspicious) {
      const pin = pinOf(flagged);
      if (pin?.approved && pin.hash === flagged.hash) this.#suspicious.delete(k);
    }
  }

  isDrifted(server: string, name: string, of: Pinned = "tool"): boolean {
    return this.#drifted.has(key(of, server, name));
  }

  isSuspicious(server: string, name: string, of: Pinned = "tool"): boolean {
    return this.cfg.on_suspicious !== "off" && this.#suspicious.has(key(of, server, name));
  }

  get blocking(): boolean {
    return this.cfg.on_drift === "block";
  }

  /** Everything `mcpgw pin` would show. Suspicious content counts only when the scan is on. */
  pending(server?: string): Change[] {
    const all = [
      ...this.#drifted.values(),
      ...this.#removed.values(),
      ...(this.cfg.on_suspicious === "off" ? [] : this.#suspicious.values()),
    ];
    return server ? all.filter((c) => c.server === server) : all;
  }

  /** `mcpgw pin`: accept every pending change and rewrite the lockfile. */
  accept(server?: string): Change[] {
    // Drifts come first in `pending`, so a drift and its findings accepted together vouch for the
    // new hash rather than the old one.
    const accepted = this.pending(server);
    const now = new Date().toISOString();
    for (const change of accepted) {
      const of = change.of ?? "tool";
      const k = key(of, change.server, change.tool);
      const pins = (this.#section(of)[change.server] ??= {});
      if (change.kind === "drift") {
        pins[change.tool] = { hash: change.to, seen: now, description: this.#shapes.get(k) ?? "" };
        this.#drifted.delete(k);
        this.#shapes.delete(k);
      } else if (change.kind === "removed") {
        delete pins[change.tool];
        this.#removed.delete(k);
      } else if (change.kind === "suspicious") {
        const pin = pins[change.tool];
        if (pin?.hash === change.hash) pin.approved = true;
        this.#suspicious.delete(k);
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
   * Every string, plus every run of adjacent text content blocks read as one: a backend that
   * streams its output in pieces can split a token across two blocks, and a per-string pass
   * never sees it whole. The structure is never changed — only characters inside text.
   */
  redact<T>(value: T): T {
    if (this.#patterns.length === 0) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redactText(v);
      if (Array.isArray(v)) return this.#acrossBlocks(v).map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  /** Redacts matches that span adjacent `{ type: "text" }` blocks, leaving the blocks in place. */
  #acrossBlocks(items: unknown[]): unknown[] {
    const isText = (x: unknown): x is { type: "text"; text: string } =>
      !!x && typeof x === "object" && (x as { type?: unknown }).type === "text" &&
      typeof (x as { text?: unknown }).text === "string";

    const out = [...items];
    for (let start = 0; start < out.length; ) {
      let end = start;
      while (end < out.length && isText(out[end])) end++;
      if (end - start > 1) this.#redactRun(out, start, end);
      start = end + 1;
    }
    return out;
  }

  #redactRun(blocks: unknown[], start: number, end: number): void {
    const run = blocks.slice(start, end) as { type: "text"; text: string }[];
    const joined = run.map((b) => b.text).join("");
    const secret = new Array<boolean>(joined.length).fill(false);
    for (const pattern of this.#patterns) {
      for (const m of joined.matchAll(pattern)) {
        for (let i = m.index; i < m.index + m[0].length; i++) secret[i] = true;
      }
    }
    let offset = 0;
    run.forEach((block, n) => {
      let text = "";
      for (let i = 0; i < block.text.length; i++) {
        const at = offset + i;
        // A secret is replaced once, in the block where it starts; its tail in later blocks goes.
        if (!secret[at]) text += block.text[i];
        else if (at === 0 || !secret[at - 1]) text += "[redacted]";
      }
      offset += block.text.length;
      if (text !== block.text) blocks[start + n] = { ...block, text };
    });
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

  /** The same cap for `prompts/get`: a prompt's text is as unbounded as a tool result's. */
  capPrompt(result: GetPromptResult): Capped<GetPromptResult> {
    const messages = [...(result.messages ?? [])];
    const last = messages.map((m) => m.content.type).lastIndexOf("text");
    const message = last < 0 ? undefined : messages[last]!;
    const text = message?.content.type === "text" ? message.content.text : undefined;
    return this.#cap(
      result,
      text,
      (text) => {
        const trimmed = [...messages];
        trimmed[last] = { ...message!, content: { type: "text", text } };
        return { ...result, messages: trimmed };
      },
      (text) => ({ ...result, messages: [{ role: "user", content: { type: "text", text } }] }),
    );
  }

  /**
   * Completions are suggestions, so a marker would be offered as one. An oversized list is cut
   * to the values that fit instead, and `hasMore` tells the client there were others.
   */
  capCompletion(result: CompleteResult): Capped<CompleteResult> {
    const size = (r: CompleteResult) => Buffer.byteLength(JSON.stringify(r));
    const max = this.cfg.max_result_bytes;
    if (size(result) <= max) return { result, bytes: size(result), truncated: false };
    const values = [...result.completion.values];
    let capped: CompleteResult;
    do {
      values.pop();
      capped = { ...result, completion: { ...result.completion, values, hasMore: true } };
    } while (values.length > 0 && size(capped) > max);
    return { result: capped, bytes: size(capped), truncated: true };
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
