import { randomUUID } from "node:crypto";

/** What the status page shows about a call waiting for a person. Arguments arrive redacted. */
export interface PendingApproval {
  id: string;
  profile: string;
  tool: string;
  canonical: string;
  rule: string;
  args: string;
  client?: string;
  client_key?: string;
  session?: string;
  since: string;
  /** When the call is refused if nobody answers. */
  until: string;
}

/**
 * Calls waiting for a person to say yes on the status page (`POST /approvals/<id>/approve|deny`).
 * In memory: an approval belongs to a live call, and a restart ends the call anyway.
 */
export class Approvals {
  readonly #pending = new Map<string, { view: PendingApproval; answer: (yes: boolean) => void }>();

  list(): PendingApproval[] {
    return [...this.#pending.values()].map((p) => p.view);
  }

  /** Puts a call on the board. `answer` settles with the decision; `close` takes it off. */
  open(view: Omit<PendingApproval, "id" | "since" | "until">, timeoutMs: number) {
    const id = randomUUID();
    const now = Date.now();
    let settle!: (yes: boolean) => void;
    const answer = new Promise<boolean>((resolve) => (settle = resolve));
    this.#pending.set(id, {
      view: { ...view, id, since: new Date(now).toISOString(), until: new Date(now + timeoutMs).toISOString() },
      answer: settle,
    });
    return { id, answer, close: () => this.#pending.delete(id) };
  }

  /** A person's answer. False when the call is no longer waiting: answered, timed out or cancelled. */
  decide(id: string, yes: boolean): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending.answer(yes);
    return true;
  }
}
