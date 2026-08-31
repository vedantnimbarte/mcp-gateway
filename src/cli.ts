#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createBackends, startBackends } from "./backend.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { startGateway } from "./server.js";

const USAGE = `mcpgw — MCP gateway

Usage:
  mcpgw start    [--config PATH] [--port N]   run the daemon
  mcpgw validate [--config PATH]              check config.yaml, exit non-zero on any problem

Config is resolved as: --config PATH, then $MCPGW_CONFIG, then ./config.yaml.`;

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

async function start(config: Config, port?: number): Promise<void> {
  const backends = createBackends(config);

  // Bind before the backends connect: a slow `npx` cold start must never delay the port (NFR-6).
  const gateway = await startGateway(config, backends, { port });
  log("listening", { url: gateway.url, profiles: Object.keys(config.profiles) });

  const shutdown = () => {
    void gateway.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await startBackends(backends.values(), (name, error) =>
    log("backend_down", { server: name, error: error.message }),
  );
  for (const backend of backends.values()) {
    if (backend.state === "up") log("backend_up", { server: backend.name, tools: backend.tools.length });
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (command !== "start" && command !== "validate") {
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

  await start(config, values.port === undefined ? undefined : Number(values.port));
  return 0; // the process stays alive on the listener
}

process.exitCode = await main(process.argv.slice(2));
