#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.js";

const USAGE = `mcpgw — MCP gateway

Usage:
  mcpgw validate [--config PATH]   check config.yaml and exit non-zero on any problem

Config is resolved as: --config PATH, then $MCPGW_CONFIG, then ./config.yaml.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  if (command !== "validate") {
    console.error(`mcpgw: "${command}" is not available yet\n\n${USAGE}`);
    return 1;
  }

  try {
    const { config, path } = loadConfig(values.config);
    const servers = Object.keys(config.servers).length;
    const profiles = Object.keys(config.profiles).length;
    console.log(`ok  ${path}  (${servers} servers, ${profiles} profiles)`);
    return 0;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error("config is invalid:");
    for (const problem of e.problems) console.error(`  - ${problem}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
