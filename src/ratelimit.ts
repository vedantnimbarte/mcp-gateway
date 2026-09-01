import type { Config } from "./config.js";

export type Grant = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * SPEC §8: a continuously-refilling token bucket plus a concurrency semaphore, both per profile
 * and shared across that profile's sessions — the limit protects the backend, not the client.
 *
 * ponytail: in-memory, so counters reset when the daemon restarts. Accepted in v1; persist them
 * if a restart-to-reset ever becomes a way around the limit.
 */
export class Limiter {
  #tokens: number;
  #last: number;
  #inflight = 0;

  constructor(
    private readonly rpm: number,
    private readonly concurrent: number,
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
}

export function limitersFor(config: Config, now?: () => number): Map<string, Limiter> {
  return new Map(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      new Limiter(profile.limits.rpm, profile.limits.concurrent, now),
    ]),
  );
}
