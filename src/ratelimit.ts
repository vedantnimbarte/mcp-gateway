import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export type Grant = { ok: true } | { ok: false; retryAfterMs: number };

/** What of a limiter survives a restart: the bucket. Its in-flight calls died with the process. */
interface Snapshot {
  rpm: number;
  tokens: number;
  at: number;
}

/**
 * SPEC §8: a continuously-refilling token bucket plus a concurrency semaphore, shared by every
 * session that draws on it — the limit protects the backend, not the client. Either bound may be
 * `Infinity`, which is how a server that sets only one of them gets the other unlimited.
 */
export class Limiter {
  #tokens: number;
  #last: number;
  #inflight = 0;

  constructor(
    readonly rpm: number,
    readonly concurrent: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = rpm;
    this.#last = now();
  }

  get inflight(): number {
    return this.#inflight;
  }

  /** Takes one token and one slot, or grants nothing at all. */
  acquire(): Grant {
    // Checked before the bucket so a rejected call does not also burn a token.
    if (this.#inflight >= this.concurrent) {
      // No principled number exists for "when will a slot free up" — it depends on the backend.
      return { ok: false, retryAfterMs: 100 };
    }

    const now = this.now();
    this.#tokens = Math.min(this.rpm, this.#tokens + ((now - this.#last) * this.rpm) / 60_000);
    this.#last = now;

    if (this.#tokens < 1) {
      return { ok: false, retryAfterMs: Math.ceil(((1 - this.#tokens) * 60_000) / this.rpm) };
    }

    this.#tokens -= 1;
    this.#inflight += 1;
    return { ok: true };
  }

  release(): void {
    if (this.#inflight > 0) this.#inflight -= 1;
  }

  snapshot(): Snapshot {
    return { rpm: this.rpm, tokens: this.#tokens, at: this.#last };
  }

  /** A snapshot taken under different limits describes a different bucket, and is ignored. */
  restore(snapshot: Snapshot): void {
    if (snapshot.rpm !== this.rpm || !Number.isFinite(snapshot.tokens)) return;
    this.#tokens = Math.min(this.rpm, snapshot.tokens);
    this.#last = Math.min(snapshot.at, this.now());
  }
}

/** Per profile by name, and per server for the servers that set `limits`. */
export interface Limiters {
  profiles: Map<string, Limiter>;
  servers: Map<string, Limiter>;
}

type Limits = { rpm?: number; concurrent?: number };

/**
 * Builds the limiters for `config`. Passing the `previous` ones keeps each limiter whose limits
 * did not change: a fresh one would refill its bucket on every reload and forget the calls in
 * flight, which the drain counts on.
 */
export function limitersFor(config: Config, now?: () => number, previous?: Limiters): Limiters {
  const build = (entries: [string, Limits][], old?: Map<string, Limiter>) =>
    new Map(
      entries.map(([name, limits]) => {
        const rpm = limits.rpm ?? Infinity;
        const concurrent = limits.concurrent ?? Infinity;
        const kept = old?.get(name);
        const same = kept && kept.rpm === rpm && kept.concurrent === concurrent;
        return [name, same ? kept : new Limiter(rpm, concurrent, now)];
      }),
    );
  return {
    profiles: build(
      Object.entries(config.profiles).map(([name, p]) => [name, p.limits]),
      previous?.profiles,
    ),
    servers: build(
      Object.entries(config.servers).flatMap(([name, s]): [string, Limits][] =>
        s.limits ? [[name, s.limits]] : [],
      ),
      previous?.servers,
    ),
  };
}

export const LIMITS_STATE = "ratelimit.state.json";

/**
 * Written on a graceful shutdown, beside the config, so restarting the daemon is not a way to
 * refill every bucket.
 *
 * ponytail: a crash skips the write, and so resets the buckets it was holding. Upgrade: write
 * periodically, if a crash-to-reset ever becomes a way around the limit.
 */
export function saveLimiters(dir: string, limiters: Limiters): void {
  const snap = (m: Map<string, Limiter>) =>
    Object.fromEntries([...m].map(([name, l]) => [name, l.snapshot()]));
  try {
    const state = { profiles: snap(limiters.profiles), servers: snap(limiters.servers) };
    writeFileSync(join(dir, LIMITS_STATE), `${JSON.stringify(state)}\n`);
  } catch {
    // Losing the buckets is the pre-persistence behaviour, not a reason to fail a shutdown.
  }
}

export function restoreLimiters(dir: string, limiters: Limiters): void {
  let state: { profiles?: Record<string, Snapshot>; servers?: Record<string, Snapshot> };
  try {
    state = JSON.parse(readFileSync(join(dir, LIMITS_STATE), "utf8"));
  } catch {
    return; // no state yet, or unreadable: start full, as before
  }
  for (const [name, l] of limiters.profiles) if (state.profiles?.[name]) l.restore(state.profiles[name]);
  for (const [name, l] of limiters.servers) if (state.servers?.[name]) l.restore(state.servers[name]);
}
