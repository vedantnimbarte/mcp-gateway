// The status page's numbers, counted from audit lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditLine } from "../src/audit.js";
import { computeStats } from "../src/stats.js";

const now = Date.parse("2026-11-08T12:00:00Z");
let n = 0;
const line = (minutesAgo: number, over: Partial<AuditLine>): AuditLine => ({
  ts: new Date(now - minutesAgo * 60_000).toISOString(),
  id: String(n++),
  method: "tools/call",
  ...over,
});

const lines: AuditLine[] = [
  line(0.5, { server: "gh", tool: "list", profile: "dev", client: { name: "claude-code", version: "1" }, status: "ok", dur_ms: 100, result_bytes: 1000 }),
  line(10, { server: "gh", tool: "list", profile: "dev", client: { name: "claude-code", version: "1" }, status: "ok", dur_ms: 300, result_bytes: 3000, cached: true }),
  line(20, { server: "gh", tool: "delete", profile: "dev", status: "denied", decision: "denied_by_policy" }),
  line(30, { server: "fs", tool: "read", profile: "ro", client: { name: "cursor", version: "1" }, status: "timeout" }),
  line(40, { method: "initialize", profile: "dev" }),
  line(45, { method: "handle", profile: "dev", result_bytes: 50_000 }),
  line(50, { method: "run_code", profile: "dev", status: "ok" }),
  // Outside the hour: counted only in a longer window.
  line(90, { server: "gh", tool: "list", profile: "dev", status: "ok", dur_ms: 200 }),
];

test("an hour's totals, latency and breakdowns", () => {
  const s = computeStats(lines, "1h", now);
  assert.deepEqual(
    { ...s.totals },
    { calls: 4, ok: 2, refused: 1, errors: 1, timeouts: 1, cached: 1, approved: 0, bytes: 4000, sessions: 1, run_code: 1, handles: 1, kept_bytes: 50_000 },
  );
  assert.equal(s.latency.p50, 300);
  assert.equal(s.tools[0]!.key, "gh__list");
  assert.equal(s.tools[0]!.calls, 2);
  assert.deepEqual(s.reasons, [{ key: "denied_by_policy", count: 1 }]);
  assert.deepEqual(s.clients, [{ key: "claude-code", calls: 2 }, { key: "cursor", calls: 1 }, { key: "unknown", calls: 1 }]);
  assert.deepEqual(s.live, { gh: 1 });
  assert.equal(s.series.length, 12);
  assert.equal(s.series.reduce((sum, b) => sum + b.ok + b.refused + b.error, 0), 4);
});

test("a longer window takes in older lines", () => {
  const s = computeStats(lines, "24h", now);
  assert.equal(s.totals.calls, 5);
  assert.equal(s.series.length, 24);
  assert.equal(s.servers.find((r) => r.key === "gh")!.calls, 4);
});
