import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuditLog } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { Guard } from "../src/guard.js";

test("a durable audit line is on disk as soon as write returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpgw-audit-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    `version: 1
servers: {}
profiles: {}
audit:
  dir: ${JSON.stringify(join(dir, "audit"))}
  durable: true
`,
  );
  const { config } = loadConfig(configPath);
  const audit = new AuditLog(config.audit, Guard.load(config, configPath));

  audit.write({ method: "tools/call", tool: "first" });
  audit.write({ method: "tools/call", tool: "second" });
  // No flush and no await: the point is that nothing is left sitting in a buffer.
  const file = join(dir, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((l) => (JSON.parse(l) as { tool: string }).tool),
    ["first", "second"],
  );
  await audit.close();
});
