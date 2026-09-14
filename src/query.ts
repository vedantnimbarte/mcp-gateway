// `mcpgw query`: SQL over the audit log, for the questions one line of jq stops answering.
// The JSONL files stay the source of truth. This builds a derived index beside them with the
// built-in node:sqlite (PRD NFR-1 as amended), catching up incrementally on every query; delete
// it and the next query rebuilds it. The daemon never imports this file.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const INDEX_FILE = "index.sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY,
    ts TEXT, session TEXT, profile TEXT, client_name TEXT, method TEXT,
    server TEXT, tool TEXT, exposed_as TEXT, decision TEXT, status TEXT,
    dur_ms INTEGER, result_bytes INTEGER,
    line TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
  CREATE INDEX IF NOT EXISTS audit_decision ON audit (decision);
  CREATE TABLE IF NOT EXISTS ingested (file TEXT PRIMARY KEY, offset INTEGER NOT NULL);
`;

/** Brings the index up to date with every audit file; returns how many lines it added. */
export function ingest(dir: string): number {
  const db = new DatabaseSync(join(dir, INDEX_FILE));
  try {
    db.exec(SCHEMA);
    const seen = db.prepare("SELECT offset FROM ingested WHERE file = ?");
    const mark = db.prepare(`
      INSERT INTO ingested (file, offset) VALUES (?, ?)
      ON CONFLICT (file) DO UPDATE SET offset = excluded.offset`);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO audit
        (id, ts, session, profile, client_name, method, server, tool, exposed_as, decision, status,
         dur_ms, result_bytes, line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let added = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const path = join(dir, file);
      const size = statSync(path).size;
      let offset = Number((seen.get(file) as { offset?: number } | undefined)?.offset ?? 0);
      if (offset > size) offset = 0; // the file was replaced: read it again; ids dedupe
      if (offset === size) continue;

      const chunk = Buffer.alloc(size - offset);
      const fd = openSync(path, "r");
      try {
        readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      // Only whole lines: the daemon may be halfway through writing the last one.
      const complete = chunk.lastIndexOf(0x0a) + 1;
      if (complete === 0) continue;

      db.exec("BEGIN");
      try {
        for (const text of chunk.subarray(0, complete).toString("utf8").split("\n")) {
          if (!text) continue;
          let l: Record<string, unknown>;
          try {
            l = JSON.parse(text);
          } catch {
            continue; // a line torn by a crash is not worth failing the query over
          }
          const s = (v: unknown) => (typeof v === "string" ? v : null);
          const n = (v: unknown) => (typeof v === "number" ? v : null);
          const client = l.client as { name?: unknown } | undefined;
          const result = insert.run(
            s(l.id) ?? `${file}:${offset}:${added}`,
            s(l.ts), s(l.session), s(l.profile), s(client?.name), s(l.method),
            s(l.server), s(l.tool), s(l.exposed_as), s(l.decision), s(l.status),
            n(l.dur_ms), n(l.result_bytes), text,
          );
          added += Number(result.changes);
        }
        mark.run(file, offset + complete);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    return added;
  } finally {
    db.close();
  }
}

/**
 * Runs one statement against a read-only connection, after catching the index up. Read-only is
 * enforced by SQLite itself, so `DELETE FROM audit` fails rather than trusting anyone's SQL.
 */
export function query(dir: string, sql: string): Record<string, unknown>[] {
  ingest(dir);
  const db = new DatabaseSync(join(dir, INDEX_FILE), { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** Rows as an aligned text table, for a terminal. */
export function renderRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";
  const columns = Object.keys(rows[0]!);
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => text(r[c]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => text(r[c])))),
  ].join("\n");
}
