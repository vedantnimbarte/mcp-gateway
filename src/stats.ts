// What the status page charts: traffic, latency, refusals and the busiest tools over a window,
// read from the JSONL audit log. The log stays the only source (PRD NFR-1 as amended: the daemon
// never touches the SQLite index), so this re-reads it, bounded and briefly cached.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AuditLine } from "./audit.js";

export const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;
export type Window = keyof typeof WINDOWS;

/** Bars per window: 5-minute, hourly and 6-hourly buckets. */
const BUCKETS: Record<Window, number> = { "1h": 12, "24h": 24, "7d": 28 };

/**
 * ponytail: at most this much of the log is read per request, newest first, so a window busier
 * than that is counted from its recent end and reported `partial`. Upgrade: aggregate as lines
 * are written instead of re-reading.
 */
const MAX_READ_BYTES = 32 * 1024 * 1024;
const CACHE_MS = 4000;

interface Row {
  key: string;
  calls: number;
  errors: number;
  refused: number;
  p95_ms: number | null;
  bytes: number;
}

export interface Stats {
  window: Window;
  since: string;
  until: string;
  partial: boolean;
  totals: {
    calls: number;
    ok: number;
    refused: number;
    errors: number;
    timeouts: number;
    cached: number;
    approved: number;
    bytes: number;
    sessions: number;
    run_code: number;
    handles: number;
    kept_bytes: number;
  };
  latency: { p50: number | null; p95: number | null; p99: number | null };
  series: { t: string; ok: number; refused: number; error: number }[];
  tools: Row[];
  servers: Row[];
  profiles: Row[];
  clients: { key: string; calls: number }[];
  reasons: { key: string; count: number }[];
  /** Calls per server in the last minute: which lines on the diagram are busy right now. */
  live: Record<string, number>;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Newest file first, each read whole or, once the budget runs out, from its tail. */
function readLines(dir: string, sinceDay: string): { lines: AuditLine[]; partial: boolean } {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) >= sinceDay)
      .sort()
      .reverse();
  } catch {
    return { lines: [], partial: false };
  }
  let budget = MAX_READ_BYTES;
  let partial = false;
  const lines: AuditLine[] = [];
  for (const file of files) {
    if (budget <= 0) {
      partial = true;
      break;
    }
    const path = join(dir, file);
    const size = statSync(path).size;
    const start = Math.max(0, size - budget);
    if (start > 0) partial = true;
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    budget -= buffer.length;
    // Starting mid-file means the first line is a fragment; the last may be half written.
    for (const text of buffer.toString("utf8").split("\n").slice(start > 0 ? 1 : 0)) {
      if (!text) continue;
      try {
        lines.push(JSON.parse(text) as AuditLine);
      } catch {
        // torn line
      }
    }
  }
  return { lines, partial };
}

export function computeStats(lines: AuditLine[], window: Window, now: number, partial = false): Stats {
  const span = WINDOWS[window];
  const since = now - span;
  const count = BUCKETS[window];
  const width = span / count;
  const series = Array.from({ length: count }, (_, i) => ({
    t: new Date(since + i * width).toISOString(),
    ok: 0,
    refused: 0,
    error: 0,
  }));

  const totals: Stats["totals"] = {
    calls: 0, ok: 0, refused: 0, errors: 0, timeouts: 0, cached: 0, approved: 0,
    bytes: 0, sessions: 0, run_code: 0, handles: 0, kept_bytes: 0,
  };
  const durations: number[] = [];
  const groups = { tools: new Map<string, Row & { d: number[] }>(), servers: new Map<string, Row & { d: number[] }>(), profiles: new Map<string, Row & { d: number[] }>() };
  const clients = new Map<string, number>();
  const reasons = new Map<string, number>();
  const live: Record<string, number> = {};

  const bump = (map: Map<string, Row & { d: number[] }>, key: string, l: AuditLine, outcome: string) => {
    const row = map.get(key) ?? { key, calls: 0, errors: 0, refused: 0, p95_ms: null, bytes: 0, d: [] };
    row.calls++;
    if (outcome === "error") row.errors++;
    if (outcome === "refused") row.refused++;
    if (outcome === "ok" && typeof l.dur_ms === "number") row.d.push(l.dur_ms);
    row.bytes += typeof l.result_bytes === "number" ? l.result_bytes : 0;
    map.set(key, row);
  };

  for (const l of lines) {
    const t = Date.parse(l.ts);
    if (!(t >= since && t <= now)) continue;
    if (l.method === "initialize") totals.sessions++;
    if (l.method === "run_code") totals.run_code++;
    if (l.method === "handle") {
      totals.handles++;
      totals.kept_bytes += typeof l.result_bytes === "number" ? l.result_bytes : 0;
    }
    if (l.method !== "tools/call") continue;

    const outcome = l.status === "denied" ? "refused" : l.status === "ok" ? "ok" : "error";
    totals.calls++;
    if (outcome === "ok") totals.ok++;
    if (outcome === "refused") totals.refused++;
    if (outcome === "error") totals.errors++;
    if (l.status === "timeout") totals.timeouts++;
    if (l.cached) totals.cached++;
    if (l.approved) totals.approved++;
    totals.bytes += typeof l.result_bytes === "number" ? l.result_bytes : 0;
    if (outcome === "ok" && typeof l.dur_ms === "number") durations.push(l.dur_ms);
    if (outcome === "refused") reasons.set(l.decision ?? "refused", (reasons.get(l.decision ?? "refused") ?? 0) + 1);

    const bucket = series[Math.min(count - 1, Math.floor((t - since) / width))]!;
    bucket[outcome === "refused" ? "refused" : outcome === "ok" ? "ok" : "error"]++;

    const tool = l.server && l.tool ? `${l.server}__${l.tool}` : (l.exposed_as ?? "unknown");
    bump(groups.tools, tool, l, outcome);
    if (l.server) bump(groups.servers, l.server, l, outcome);
    if (l.profile) bump(groups.profiles, l.profile, l, outcome);
    const client = l.client?.name ?? "unknown";
    clients.set(client, (clients.get(client) ?? 0) + 1);
    if (l.server && now - t <= 60_000) live[l.server] = (live[l.server] ?? 0) + 1;
  }

  const finish = (map: Map<string, Row & { d: number[] }>, top: number): Row[] =>
    [...map.values()]
      .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
      .slice(0, top)
      .map(({ d, ...row }) => ({ ...row, p95_ms: percentile(d.sort((a, b) => a - b), 95) }));

  durations.sort((a, b) => a - b);
  return {
    window,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    partial,
    totals,
    latency: { p50: percentile(durations, 50), p95: percentile(durations, 95), p99: percentile(durations, 99) },
    series,
    // Every tool, so the tools view can show each one's traffic; the busiest come first.
    tools: finish(groups.tools, 2000),
    servers: finish(groups.servers, 50),
    profiles: finish(groups.profiles, 50),
    clients: [...clients]
      .map(([key, calls]) => ({ key, calls }))
      .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
      .slice(0, 8),
    reasons: [...reasons]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    live,
  };
}

const cache = new Map<string, { at: number; stats: Stats }>();

/** `/audit/stats`: the window's numbers, re-read at most every few seconds however many tabs poll. */
export function auditStats(dir: string, window: Window, now = Date.now()): Stats {
  const key = `${dir}|${window}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.stats;
  const sinceDay = new Date(now - WINDOWS[window]).toISOString().slice(0, 10);
  const { lines, partial } = readLines(dir, sinceDay);
  const stats = computeStats(lines, window, now, partial);
  cache.set(key, { at: now, stats });
  return stats;
}
