// `mcpgw init`: moving over from clients that each run their own servers. It reads their MCP
// configs, merges the servers into config.yaml (secrets lifted into .env beside it), and with
// --clients points each client at the gateway instead. Plans first and writes nothing without
// --yes; every file it changes is backed up first.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseEnv } from "node:util";
import YAML from "yaml";
import { parseConfig } from "./config.js";

export type ClientKind = "claude-desktop" | "cursor" | "claude-code" | "windsurf";
export interface ClientFile {
  kind: ClientKind;
  path: string;
}

/** Where each client keeps its user-wide MCP servers, on this platform. */
export function clientFiles(home: string, platform: NodeJS.Platform, appData?: string): ClientFile[] {
  const desktop =
    platform === "win32"
      ? join(appData ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { kind: "claude-desktop", path: desktop },
    { kind: "cursor", path: join(home, ".cursor", "mcp.json") },
    // ponytail: user-wide servers only; per-project ones in .mcp.json and under `projects` stay put.
    { kind: "claude-code", path: join(home, ".claude.json") },
    { kind: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json") },
  ];
}

type Entry = Record<string, unknown>;
export interface ServerPlan {
  name: string;
  def: Record<string, unknown>;
  from: ClientKind[];
}
export interface ClientPlan {
  file: ClientFile;
  found: number;
  imported: string[];
  skipped: { name: string; why: string }[];
  /** Entries already pointing at this gateway: rewriting leaves one, never two. */
  gateway: string[];
}
export interface InitPlan {
  configPath: string;
  configExists: boolean;
  profile: string;
  clients: ClientPlan[];
  add: ServerPlan[];
  already: { name: string; existing: string }[];
  /** Secrets moved out of client configs, by variable name, to append to .env. */
  env: Record<string, string>;
  /** Variables the servers name that are set nowhere the gateway will look. */
  unset: string[];
  rewrite: { file: ClientFile; entry: Entry; name: string }[];
  /** Why client configs will not be rewritten, when they will not. */
  rewriteBlocked?: string;
}

const VAR_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SAFE_ENV_VALUE = /^[A-Za-z0-9_\-.:/+=@,~]*$/;

/** A server key the config accepts: letters, digits and dashes, at most 48. */
export function serverKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return key || "server";
}

const envName = (...parts: string[]) =>
  parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^([0-9])/, "_$1");

/** What makes two definitions the same server, whichever client they came from. */
function signature(def: Record<string, unknown>): string {
  return JSON.stringify([def.transport === "stdio" ? "stdio" : "remote", def.command ?? def.url, def.args ?? []]);
}

function isGatewayEntry(entry: Entry, port: number): boolean {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (String(entry.command ?? "").includes("mcpgw-bridge") || args.some((a) => a.includes("bridge.js") && args.includes("--url"))) {
    return true;
  }
  const url = String(entry.url ?? entry.serverUrl ?? "");
  try {
    const u = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && Number(u.port) === port && u.pathname.startsWith("/mcp/");
  } catch {
    return false;
  }
}

/**
 * One client entry as a gateway server, with every env and header value lifted into a variable.
 * Names a variable after the entry's own key where it can, so GITHUB_PERSONAL_ACCESS_TOKEN stays
 * itself; a clash with a different value gets the server's name in front.
 */
function convert(
  name: string,
  entry: Entry,
  claim: (preferred: string, fallback: string, value: string) => string,
): { def: Record<string, unknown> } | { skip: string } {
  if (entry.disabled === true) return { skip: "disabled in the client" };
  const lift = (values: unknown, prefix: (key: string) => [string, string]) => {
    if (!values || typeof values !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
      const value = String(raw);
      if (VAR_REF.test(value)) {
        out[key] = value; // already a reference; the gateway must have it set
        continue;
      }
      const [preferred, fallback] = prefix(key);
      out[key] = `\${${claim(preferred, fallback, value)}}`;
    }
    return Object.keys(out).length ? out : undefined;
  };

  if (typeof entry.command === "string") {
    const def: Record<string, unknown> = { transport: "stdio", command: entry.command };
    if (Array.isArray(entry.args) && entry.args.length) def.args = entry.args.map(String);
    const env = lift(entry.env, (key) => [envName(key), envName(name, key)]);
    if (env) def.env = env;
    if (typeof entry.cwd === "string") def.cwd = entry.cwd;
    return { def };
  }
  const url = entry.url ?? entry.serverUrl;
  if (typeof url === "string") {
    const sse = entry.type === "sse" || entry.transport === "sse";
    const def: Record<string, unknown> = { transport: sse ? "sse" : "http", url };
    // A header value is usually a credential: always namespaced by the server it belongs to.
    const headers = lift(entry.headers, (key) => [envName(name, key), envName(name, key, "2")]);
    if (headers) def.headers = headers;
    return { def };
  }
  return { skip: "has neither a command nor a url" };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Everything `mcpgw init` would do, decided without writing anything. */
export function planInit(opts: {
  configPath: string;
  files: ClientFile[];
  profile: string;
  rewriteClients: boolean;
  /** How a stdio-only client launches the bridge: the node binary, and bridge.js. */
  node: string;
  bridge: string;
}): InitPlan {
  const configExists = existsSync(opts.configPath);
  const current = configExists ? ((YAML.parse(readFileSync(opts.configPath, "utf8")) ?? {}) as Record<string, any>) : {};
  const existing = (current.servers ?? {}) as Record<string, Record<string, unknown>>;
  const port: number = current.listen?.port ?? 8420;
  const tls = Boolean(current.listen?.tls);
  const envFile = join(dirname(opts.configPath), ".env");
  const known = (existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}) as Record<string, string>;

  const env: Record<string, string> = {};
  const taken = (n: string) => n in env || n in known;
  const claim = (preferred: string, fallback: string, value: string): string => {
    for (const candidate of [preferred, fallback]) {
      if (!taken(candidate) || (env[candidate] ?? known[candidate]) === value) {
        if (!(candidate in known)) env[candidate] = value;
        return candidate;
      }
    }
    let i = 2;
    while (taken(`${fallback}_${i}`)) i++;
    env[`${fallback}_${i}`] = value;
    return `${fallback}_${i}`;
  };

  const bySignature = new Map<string, string>(Object.entries(existing).map(([n, d]) => [signature(d), n]));
  const names = new Set(Object.keys(existing));
  const add: ServerPlan[] = [];
  const already: InitPlan["already"] = [];
  const clients: ClientPlan[] = [];

  for (const file of opts.files) {
    const json = existsSync(file.path) ? readJson(file.path) : undefined;
    const servers = json?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    const plan: ClientPlan = { file, found: 0, imported: [], skipped: [], gateway: [] };
    for (const [raw, value] of Object.entries(servers as Record<string, Entry>)) {
      plan.found++;
      if (isGatewayEntry(value, port)) {
        plan.gateway.push(raw);
        continue;
      }
      const name = serverKey(raw);
      const converted = convert(name, value, claim);
      if ("skip" in converted) {
        plan.skipped.push({ name: raw, why: converted.skip });
        continue;
      }
      const sig = signature(converted.def);
      const same = bySignature.get(sig);
      if (same) {
        const planned = add.find((s) => s.name === same);
        if (planned && !planned.from.includes(file.kind)) planned.from.push(file.kind);
        if (!planned && !already.some((a) => a.existing === same)) already.push({ name: raw, existing: same });
        plan.imported.push(raw);
        continue;
      }
      let unique = name;
      for (let i = 2; names.has(unique); i++) unique = `${name}-${i}`;
      names.add(unique);
      bySignature.set(sig, unique);
      add.push({ name: unique, def: converted.def, from: [file.kind] });
      plan.imported.push(raw);
    }
    clients.push(plan);
  }

  // References the servers make that nothing provides: neither the environment, nor .env, nor us.
  const unset = new Set<string>();
  for (const s of add) {
    for (const group of [s.def.env, s.def.headers]) {
      for (const v of Object.values((group ?? {}) as Record<string, string>)) {
        const name = VAR_REF.exec(v)?.[1];
        if (name && !(name in env) && !(name in known) && process.env[name] === undefined) unset.add(name);
      }
    }
  }

  const hasToken = Boolean(current.listen?.token) || (current.listen?.clients ?? []).length > 0;
  const url = `${tls ? "https" : "http"}://127.0.0.1:${port}/mcp/${opts.profile}`;
  const rewrite: InitPlan["rewrite"] = [];
  let rewriteBlocked: string | undefined;
  if (opts.rewriteClients && hasToken) {
    rewriteBlocked = "the gateway requires a token, which this will not copy into client files; add it to each client yourself";
  } else if (opts.rewriteClients) {
    for (const c of clients) {
      if (c.imported.length === 0 && c.gateway.length === 0) continue;
      const entry: Entry =
        c.file.kind === "claude-code"
          ? { type: "http", url }
          : { command: opts.node, args: [opts.bridge, "--url", url] };
      rewrite.push({ file: c.file, entry, name: c.gateway[0] ?? "gateway" });
    }
  }

  return {
    configPath: opts.configPath,
    configExists,
    profile: opts.profile,
    clients,
    add,
    already,
    env,
    unset: [...unset],
    rewrite,
    rewriteBlocked,
  };
}

/** `.env` syntax for one value: bare when safe, else quoted with whichever quote it lacks. */
function envLine(name: string, value: string): string | undefined {
  if (value.includes("\n")) return undefined;
  if (SAFE_ENV_VALUE.test(value)) return `${name}=${value}`;
  if (!value.includes("'")) return `${name}='${value}'`;
  if (!value.includes('"')) return `${name}="${value}"`;
  return undefined;
}

/** The config text the plan produces: merged into the file as written, comments and all. */
export function configText(plan: InitPlan): string {
  if (!plan.configExists) {
    const servers = Object.fromEntries(plan.add.map((s) => [s.name, s.def]));
    const body = YAML.stringify({ version: 1, servers, profiles: { [plan.profile]: { servers: ["*"] } } });
    return `# Written by mcpgw init. Secrets are \${VAR} references, kept in .env beside this file.\n${body}`;
  }
  const doc = YAML.parseDocument(readFileSync(plan.configPath, "utf8"));
  for (const s of plan.add) doc.setIn(["servers", s.name], doc.createNode(s.def));
  if (!doc.hasIn(["profiles", plan.profile])) doc.setIn(["profiles", plan.profile], doc.createNode({ servers: ["*"] }));
  return String(doc);
}

/**
 * Writes the plan: .env first (the config refers to it), then config.yaml, then each client.
 * The new config is validated before anything is written, with the plan's variables in scope.
 * Returns the files written, and the secrets that could not go into .env.
 */
export function applyInit(plan: InitPlan): { written: string[]; problems: string[] } {
  const written: string[] = [];
  const problems: string[] = [];
  const text = configText(plan);

  const lines: string[] = [];
  for (const [name, value] of Object.entries(plan.env)) {
    const line = envLine(name, value);
    if (line) lines.push(line);
    else problems.push(`${name}: the value has quotes or line breaks .env cannot hold; set it in the environment`);
  }

  // Validate as the daemon will load it, with the new variables visible but not yet written.
  const added = Object.keys(plan.env).filter((n) => process.env[n] === undefined);
  for (const n of added) process.env[n] = plan.env[n];
  try {
    for (const n of plan.unset) process.env[n] ??= "unset";
    parseConfig(text, plan.configPath);
  } finally {
    for (const n of [...added, ...plan.unset]) delete process.env[n];
  }

  const backup = (path: string, suffix: string) => {
    if (existsSync(path)) copyFileSync(path, `${path}${suffix}`);
  };

  if (lines.length) {
    const envFile = join(dirname(plan.configPath), ".env");
    const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const sep = before && !before.endsWith("\n") ? "\n" : "";
    writeFileSync(envFile, `${before}${sep}# added by mcpgw init\n${lines.join("\n")}\n`, { mode: 0o600 });
    written.push(envFile);
  }

  backup(plan.configPath, ".bak");
  writeFileSync(plan.configPath, text);
  written.push(plan.configPath);

  for (const r of plan.rewrite) {
    const json = readJson(r.file.path);
    if (!json) continue;
    const client = plan.clients.find((c) => c.file.path === r.file.path)!;
    const servers = { ...(json.mcpServers as Record<string, Entry>) };
    for (const name of [...client.imported, ...client.gateway]) delete servers[name];
    servers[r.name] = r.entry;
    backup(r.file.path, ".mcpgw-backup");
    writeFileSync(r.file.path, `${JSON.stringify({ ...json, mcpServers: servers }, null, 2)}\n`);
    written.push(r.file.path);
  }
  return { written, problems };
}

/** The plan, as a person reads it before saying --yes. */
export function describePlan(plan: InitPlan): string {
  const out: string[] = [];
  if (plan.clients.length === 0) {
    return "No client configs with MCP servers found (Claude Desktop, Cursor, Claude Code, Windsurf).";
  }
  out.push("Client configs found:");
  for (const c of plan.clients) {
    out.push(`  ${c.file.kind.padEnd(15)} ${c.found} server(s)  ${c.file.path}`);
    for (const s of c.skipped) out.push(`      skipped ${s.name}: ${s.why}`);
  }
  out.push("");
  out.push(`${plan.configExists ? "Add to" : "Create"} ${plan.configPath}:`);
  if (plan.add.length === 0) out.push("  (no new servers)");
  for (const s of plan.add) {
    const how = s.def.transport === "stdio" ? `${s.def.command} ${((s.def.args as string[]) ?? []).join(" ")}` : `${s.def.transport} ${s.def.url}`;
    out.push(`  ${s.name.padEnd(20)} ${how.trim()}   from ${s.from.join(", ")}`);
  }
  for (const a of plan.already) out.push(`  ${a.name.padEnd(20)} already there as "${a.existing}"`);
  if (!plan.configExists) out.push(`  and a "${plan.profile}" profile with every server`);
  const vars = Object.keys(plan.env);
  if (vars.length) {
    out.push("");
    out.push(`Move ${vars.length} secret(s) into ${join(dirname(plan.configPath), ".env")}, referenced as \${NAME}:`);
    out.push(`  ${vars.join(", ")}`);
  }
  if (plan.unset.length) {
    out.push("");
    out.push(`Set these before starting; the client configs refer to them but they are not set here: ${plan.unset.join(", ")}`);
  }
  out.push("");
  if (plan.rewriteBlocked) {
    out.push(`Client configs left as they are: ${plan.rewriteBlocked}.`);
  } else if (plan.rewrite.length) {
    out.push("Point these clients at the gateway (each backed up first, as <file>.mcpgw-backup):");
    for (const r of plan.rewrite) out.push(`  ${r.file.kind.padEnd(15)} ${r.file.path}`);
  } else {
    out.push("Client configs left as they are. Add --clients to point them at the gateway.");
  }
  out.push("");
  out.push("Nothing has been written. Re-run with --yes to apply.");
  return out.join("\n");
}
