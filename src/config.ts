import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { globMatch } from "./glob.js";

/** SPEC §1.3 */
const Restart = z
  .object({
    max_retries: z.number().int().min(0).default(5),
    backoff_ms: z.number().int().min(100).default(1000),
  })
  .default({});

const Server = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    restart: Restart,
  }),
  z.object({
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    restart: Restart,
  }),
]);

const Profile = z.object({
  servers: z.array(z.string()).default(["*"]),
  allow: z.array(z.string()).optional(), // absent = all not denied
  deny: z.array(z.string()).default([]),
  rename: z.record(z.string(), z.string()).default({}), // canonical -> alias
  limits: z
    .object({
      rpm: z.number().int().positive().default(120),
      concurrent: z.number().int().positive().default(8),
    })
    .default({}),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  listen: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8420),
      token: z.string().optional(),
    })
    .default({}),
  defaults: z
    .object({
      call_timeout_ms: z.number().int().positive().default(30000),
      connect_timeout_ms: z.number().int().positive().default(10000),
    })
    .default({}),
  servers: z.record(z.string(), Server),
  profiles: z.record(z.string(), Profile),
  guard: z
    .object({
      pin_tools: z.boolean().default(true),
      on_drift: z.enum(["block", "warn"]).default("block"),
      max_result_bytes: z.number().int().positive().default(262144),
      redact: z.array(z.string()).default([]),
    })
    .default({}),
  audit: z
    .object({
      dir: z.string().default("./audit"),
      log_args: z.enum(["full", "hashed", "none"]).default("hashed"),
      log_results: z.enum(["full", "truncated", "none"]).default("none"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof Server>;
export type ProfileConfig = z.infer<typeof Profile>;

/** Every problem found, reported at once (SPEC §1.4). */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
  }
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SERVER_KEY = /^[a-zA-Z0-9-]{1,48}$/; // SPEC §2
const PROFILE_KEY = /^[a-zA-Z0-9_-]{1,64}$/; // it appears in the URL path
const ALIAS = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Redact patterns are authored with a leading `(?i)` in the SPEC sample; JS has no inline
 * flags, so translate that one form into the `i` flag. Anything else is a plain RegExp.
 */
export function compileRedact(pattern: string): RegExp {
  const ci = pattern.startsWith("(?i)");
  return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "gi" : "g");
}

/** `${VAR}` substitution in string values only, before zod parsing (SPEC §1.4). */
function interpolate(node: unknown, missing: Set<string>): unknown {
  if (typeof node === "string") {
    return node.replace(ENV_REF, (whole, name: string) => {
      const value = process.env[name];
      if (value === undefined) {
        missing.add(name);
        return whole;
      }
      return value;
    });
  }
  if (Array.isArray(node)) return node.map((n) => interpolate(n, missing));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, missing)]),
    );
  }
  return node;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** The server component of a canonical `<server>__<tool>` name. */
function serverOf(canonical: string): string | undefined {
  const i = canonical.indexOf("__");
  return i > 0 ? canonical.slice(0, i) : undefined;
}

/** SPEC §1.4 cross-checks. Collects every problem rather than throwing on the first. */
function crossCheck(cfg: Config): string[] {
  const problems: string[] = [];

  if (!isLoopback(cfg.listen.host) && !cfg.listen.token) {
    problems.push(
      `listen.host is ${cfg.listen.host} (not loopback) and listen.token is unset — ` +
        `port reachability would be full authority over every backend credential (NFR-2)`,
    );
  }

  for (const key of Object.keys(cfg.servers)) {
    if (!SERVER_KEY.test(key) || key.includes("__")) {
      problems.push(`servers.${key}: name must match ${SERVER_KEY.source} and contain no "__"`);
    }
  }

  for (const [i, pattern] of cfg.guard.redact.entries()) {
    try {
      compileRedact(pattern);
    } catch (e) {
      problems.push(`guard.redact[${i}]: not a valid regex — ${(e as Error).message}`);
    }
  }

  for (const [name, profile] of Object.entries(cfg.profiles)) {
    if (!PROFILE_KEY.test(name)) {
      problems.push(`profiles.${name}: name must match ${PROFILE_KEY.source}`);
    }

    const wildcard = profile.servers.includes("*");
    for (const s of profile.servers) {
      if (s !== "*" && !(s in cfg.servers)) {
        problems.push(`profiles.${name}.servers: unknown server "${s}"`);
      }
    }
    const reachable = (server: string) =>
      (wildcard || profile.servers.includes(server)) && server in cfg.servers;

    // Renames are checked as far as is knowable without the backends: the canonical name's
    // server must be reachable from this profile, and the name must survive the globs.
    // Collisions against real backend tool names are re-checked in catalog.ts at connect time.
    const aliasOwner = new Map<string, string>();
    for (const [canonical, alias] of Object.entries(profile.rename)) {
      const where = `profiles.${name}.rename.${canonical}`;
      if (!ALIAS.test(alias)) {
        problems.push(`${where}: alias "${alias}" must match ${ALIAS.source}`);
      }

      const server = serverOf(canonical);
      if (!server) {
        problems.push(`${where}: not a canonical <server>__<tool> name`);
      } else if (!reachable(server)) {
        problems.push(`${where}: server "${server}" is not in this profile`);
      } else if (profile.deny.some((g) => globMatch(g, canonical))) {
        problems.push(`${where}: "${canonical}" is denied by this profile, so it is never exposed`);
      } else if (profile.allow && !profile.allow.some((g) => globMatch(g, canonical))) {
        problems.push(`${where}: "${canonical}" matches no allow glob, so it is never exposed`);
      }

      const twin = aliasOwner.get(alias);
      if (twin) {
        problems.push(
          `profiles.${name}.rename: "${twin}" and "${canonical}" both map to "${alias}"`,
        );
      }
      aliasOwner.set(alias, canonical);
    }
    // An alias must not shadow a tool this profile still exposes under its canonical name.
    for (const alias of aliasOwner.keys()) {
      const server = serverOf(alias);
      if (server && reachable(server) && !(alias in profile.rename)) {
        problems.push(
          `profiles.${name}.rename: alias "${alias}" is itself a canonical name this profile exposes`,
        );
      }
    }
  }

  return problems;
}

/** `--config PATH` → `$MCPGW_CONFIG` → `./config.yaml` (SPEC §1.1). */
export function resolveConfigPath(explicit?: string): string {
  return resolve(explicit ?? process.env.MCPGW_CONFIG ?? "config.yaml");
}

export function loadConfig(explicit?: string): { config: Config; path: string } {
  const path = resolveConfigPath(explicit);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError([`cannot read ${path}: ${(e as Error).message}`]);
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    throw new ConfigError([`${path} is not valid YAML: ${(e as Error).message}`]);
  }

  const missing = new Set<string>();
  doc = interpolate(doc, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      [...missing].map((v) => `missing environment variable \${${v}} referenced by the config`),
    );
  }

  const parsed = ConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const config = parsed.data;
  for (const server of Object.values(config.servers)) {
    if (server.transport === "stdio" && server.cwd?.startsWith("~")) {
      server.cwd = homedir() + server.cwd.slice(1);
    }
  }

  const problems = crossCheck(config);
  if (problems.length > 0) throw new ConfigError(problems);

  return { config, path };
}
