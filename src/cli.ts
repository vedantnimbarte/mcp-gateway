#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { Pipeline } from "./pipeline.js";
import { Pool } from "./pool.js";
import { startGateway } from "./server.js";

const USAGE = `mcpgw — MCP gateway

Usage:
  mcpgw start    [--config PATH] [--port N]   run the daemon
  mcpgw validate [--config PATH]              check config.yaml, exit non-zero on any problem
  mcpgw list     [--config PATH] [--profile P]  effective tools per profile, and why

Config is resolved as: --config PATH, then $MCPGW_CONFIG, then ./config.yaml.`;

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

async function start(config: Config, port?: number): Promise<void> {
  const pool = new Pool(config, log);

  // Bind before the backends connect: a slow `npx` cold start must never delay the port (NFR-6).
  const gateway = await startGateway(config, pool, { port });
  log("listening", { url: gateway.url, profiles: Object.keys(config.profiles) });

  const shutdown = () => {
    void gateway.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Failures are logged and retried by the backend itself; nothing here blocks the listener.
  await pool.start();
}

/**
 * Answers "why can't the model see this tool" by printing every catalog entry with the rule
 * that decided it. Connects the backends, prints, exits — it never binds the port.
 */
async function list(config: Config, only?: string): Promise<number> {
  const profiles = only ? [only] : Object.keys(config.profiles);
  if (only && !(only in config.profiles)) {
    console.error(`no such profile: ${only}`);
    return 1;
  }

  const pool = new Pool(config);
  await pool.start();
  const pipeline = new Pipeline(config, pool);

  for (const profile of profiles) {
    const rows = pipeline.explain(profile).sort((a, b) => a.exposed.localeCompare(b.exposed));
    const allowed = rows.filter((r) => r.decision.allow).length;
    console.log(`
profile ${profile}  (${allowed} of ${rows.length} tools exposed)`);
    for (const row of rows) {
      const renamed = row.exposed === row.entry.canonical ? "" : `  [${row.entry.canonical}]`;
      const verdict = row.decision.allow ? "allow" : row.decision.reason;
      console.log(`  ${verdict.padEnd(21)} ${row.exposed.padEnd(40)} ${row.decision.rule}${renamed}`);
    }
  }

  await pool.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      profile: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (command !== "start" && command !== "validate" && command !== "list") {
    console.error(`mcpgw: "${command}" is not available yet\n\n${USAGE}`);
    return 1;
  }

  let config: Config;
  let path: string;
  try {
    ({ config, path } = loadConfig(values.config));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error("config is invalid:");
    for (const problem of e.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (command === "validate") {
    const servers = Object.keys(config.servers).length;
    const profiles = Object.keys(config.profiles).length;
    console.log(`ok  ${path}  (${servers} servers, ${profiles} profiles)`);
    return 0;
  }

  if (command === "list") return list(config, values.profile);

  await start(config, values.port === undefined ? undefined : Number(values.port));
  return 0; // the process stays alive on the listener
}

process.exitCode = await main(process.argv.slice(2));
