import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
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
  result?: unknown;
  error?: { code: number; message: string };
  [key: string]: unknown;
}

/** What callers pass: the documented fields, plus whatever else an event carries. */
export type AuditInput = Partial<AuditLine> & { method: string };

let counter = 0;
/** Short, sortable-ish, and unique enough for one process (SPEC §7 only needs an id). */
function lineId(): string {
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

/**
 * One JSON object per line in `audit/YYYY-MM-DD.jsonl`, UTC (SPEC §7). Writes go through a
 * stream and are never awaited by the request path — durability here is deliberately
 * best-effort, this is a personal tool and not a compliance system (ARCHITECTURE §5).
 */
export class AuditLog {
  readonly dir: string;
  #stream?: WriteStream;
  #date?: string;

  constructor(
    private readonly cfg: Config["audit"],
    private readonly guard: Guard,
  ) {
    this.dir = resolve(cfg.dir);
  }

  /** Fire and forget. Never throws: a failed log line must not fail the call it describes. */
  write(line: AuditInput): void {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.#date) this.#rotate(today);
      const full = { ts: new Date().toISOString(), id: lineId(), ...line };
      this.#stream?.write(`${JSON.stringify(full)}\n`);
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
    mkdirSync(this.dir, { recursive: true });
    this.#stream = createWriteStream(join(this.dir, `${today}.jsonl`), { flags: "a" });
    this.#stream.on("error", () => {});
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
    if (stream) await new Promise<void>((done) => stream.end(done));
  }
}
