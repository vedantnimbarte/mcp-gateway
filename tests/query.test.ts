import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INDEX_FILE, ingest, query, renderRows } from "../src/query.js";

const line = (id: string, over: Record<string, unknown>) =>
  `${JSON.stringify({ ts: "2026-09-14T10:00:00.000Z", id, method: "tools/call", ...over })}\n`;

function auditDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpgw-query-"));
  writeFileSync(
    join(dir, "2026-09-13.jsonl"),
    line("a1", { server: "github", tool: "delete_repo", decision: "denied_by_policy", dur_ms: 1 }) +
      line("a2", { server: "github", tool: "list_issues", decision: "allow", dur_ms: 120 }),
  );
  writeFileSync(
    join(dir, "2026-09-14.jsonl"),
    line("b1", { server: "github", tool: "delete_repo", decision: "denied_by_policy" }) +
      line("b2", { server: "fs", tool: "read", decision: "allow", client: { name: "claude-code" } }),
  );
  return dir;
}

test("the question one line of jq could not answer", () => {
  const rows = query(
    auditDir(),
    "select tool, count(*) as n from audit where decision != 'allow' group by tool",
  );
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ tool: "delete_repo", n: 2 }]);
});

test("unindexed fields are still reachable through the original line", () => {
  const rows = query(
    auditDir(),
    "select client_name, json_extract(line, '$.client.name') as j from audit where id = 'b2'",
  );
  assert.deepEqual({ ...rows[0] }, { client_name: "claude-code", j: "claude-code" });
});

test("the index catches up incrementally, and never reads a half-written line", () => {
  const dir = auditDir();
  assert.equal(ingest(dir), 4);
  assert.equal(ingest(dir), 0, "nothing new, nothing re-read");

  appendFileSync(join(dir, "2026-09-14.jsonl"), line("b3", { decision: "allow" }) + '{"id":"b4","ts');
  assert.equal(ingest(dir), 1, "the torn tail waits for its newline");
  appendFileSync(join(dir, "2026-09-14.jsonl"), '":"x"}\n');
  assert.equal(ingest(dir), 1);

  rmSync(join(dir, INDEX_FILE));
  assert.equal(ingest(dir), 6, "a deleted index is rebuilt from the JSONL");
});

test("queries cannot write: the connection is read-only", () => {
  const dir = auditDir();
  assert.throws(() => query(dir, "delete from audit"), /readonly/i);
  assert.equal(query(dir, "select count(*) as n from audit")[0]?.n, 4);
});

test("rows render as an aligned table", () => {
  assert.equal(
    renderRows([{ tool: "delete_repo", n: 2 }, { tool: "x", n: null }]),
    "tool         n\n-----------  -\ndelete_repo  2\nx",
  );
  assert.equal(renderRows([]), "(no rows)");
});
