import { createHash } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeSync,
  type WriteStream,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, type Guard } from "./guard.js";
import type { Config } from "./config.js";

export type AuditDecision =
  | "allow"
  | "denied_by_policy"
  | "not_allowed"
  | "server_not_in_profile"
  | "unknown_profile"
  | "drift_blocked"
  | "suspicious_blocked"
  | "approval_denied"
  | "approval_unavailable"
  | "server_unavailable"
  | "rate_limited"
  | "unroutable";

export interface AuditLine {
  ts: string;
  id: string;
  session?: string;
  profile?: string;
  client?: { name: string; version: string };
  method: string;
  server?: string;
  tool?: string;
  exposed_as?: string;
  decision?: AuditDecision;
  args?: unknown;
  args_hash?: string;
  dur_ms?: number;
  status?: "ok" | "error" | "timeout" | "denied";
  result_bytes?: number;
  truncated?: boolean;
  /** Answered from the response cache, without a backend round-trip. */
  cached?: boolean;
  /** A human approved this call in the client before it ran (`profiles.*.approve`). */
  approved?: boolean;
  result?: unknown;
  error?: { code: number; message: string };
  [key: string]: unknown;
}

/** What callers pass: the documented fields, plus whatever else an event carries. */
export type AuditInput = Partial<AuditLine> & { method: string };

/** How far back `recentLines` reads into the newest file: bounded, whatever the day's volume. */
const RECENT_BYTES = 2 * 1024 * 1024;

/**
 * The last `n` lines of the newest audit file, newest last, optionally only the refusals and
 * errors. Reads only the file's tail, so a busy day's log costs the same as a quiet one.
 *
 * ponytail: today's (newest) file only; just after midnight UTC it holds little. Upgrade: walk
 * back into the previous file when this one runs short.
 */
export function recentLines(dir: string, n: number, deniedOnly = false): AuditLine[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const newest = files.at(-1);
  if (!newest) return [];

  const path = join(dir, newest);
  const size = statSync(path).size;
  const start = Math.max(0, size - RECENT_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  // Starting mid-file means the first line is a fragment.
  const lines = text.split("\n").slice(start > 0 ? 1 : 0).filter(Boolean);

  const parsed: AuditLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as AuditLine);
    } catch {
      // A line cut by a crash mid-write is skipped, not fatal.
    }
  }
  const wanted = deniedOnly
    ? parsed.filter((l) => (l.decision !== undefined && l.decision !== "allow") || l.status === "error")
    : parsed;
  return wanted.slice(-n);
}

let counter = 0;
/** Short, sortable-ish, and unique enough for one process (SPEC §7 only needs an id). */
function lineId(): string {
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

/**
 * One JSON object per line in `audit/YYYY-MM-DD.jsonl`, UTC (SPEC §7). By default writes go
 * through a stream and are never awaited by the request path — best-effort, since this is a
 * personal tool and not a compliance system (ARCHITECTURE §5). `durable` trades that for fsync.
 */
export class AuditLog {
  readonly dir: string;
  /** Sees every line as it is written — `mcpgw start --verbose` mirrors them to stderr. */
  onWrite?: (line: AuditLine) => void;
  #stream?: WriteStream;
  /** Used instead of the stream under `audit.durable`. */
  #fd?: number;
  #date?: string;

  constructor(
    private readonly cfg: Config["audit"],
    private readonly guard: Guard,
  ) {
    this.dir = resolve(cfg.dir);
  }

  /**
   * Fire and forget. Never throws: a failed log line must not fail the call it describes.
   *
   * By default the stream buffers, so a hard crash can lose the last few lines. `durable: true`
   * appends and fsyncs each line synchronously instead.
   * ponytail: synchronously — every audited request blocks the event loop on a disk flush. That
   * is the price of surviving a crash; leave it off unless losing lines costs more.
   */
  write(line: AuditInput): void {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.#date) this.#rotate(today);
      const full = { ts: new Date().toISOString(), id: lineId(), ...line };
      const text = `${JSON.stringify(full)}\n`;
      if (this.#fd !== undefined) {
        writeSync(this.#fd, text);
        fsyncSync(this.#fd);
      } else {
        this.#stream?.write(text);
      }
      this.onWrite?.(full);
    } catch {
      // Losing an audit line is preferable to losing the request.
    }
  }

  /** Shapes arguments per `log_args`, after redaction. */
  argFields(args: unknown): Pick<AuditLine, "args" | "args_hash"> {
    if (this.cfg.log_args === "none") return {};
    const clean = this.guard.redact(args ?? {});
    if (this.cfg.log_args === "full") return { args: clean };
    const digest = createHash("sha256").update(canonicalJson(clean)).digest("hex");
    return { args_hash: `sha256:${digest}` };
  }

  /**
   * Shapes the result per `log_results`. `truncated` records what the client actually received,
   * capped again to a short excerpt — the point of the log is to be greppable, not complete.
   */
  resultFields(result: unknown): Pick<AuditLine, "result"> {
    if (this.cfg.log_results === "none") return {};
    if (this.cfg.log_results === "full") return { result };
    const text = JSON.stringify(result) ?? "";
    return { result: text.length > 512 ? `${text.slice(0, 512)}…` : text };
  }

  #rotate(today: string): void {
    this.#stream?.end();
    this.#stream = undefined;
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${today}.jsonl`);
    if (this.cfg.durable) {
      this.#fd = openSync(path, "a");
    } else {
      this.#stream = createWriteStream(path, { flags: "a" });
      this.#stream.on("error", () => {});
    }
    this.#date = today;
  }

  /**
   * Waits for what has been written to reach the file. The request path never calls this —
   * it exists for shutdown and for tests, which must not race the stream's own buffering.
   */
  async flush(): Promise<void> {
    const stream = this.#stream;
    if (stream) await new Promise<void>((done) => stream.write("", () => done()));
  }

  async close(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    this.#date = undefined;
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
    if (stream) await new Promise<void>((done) => stream.end(done));
  }
}
