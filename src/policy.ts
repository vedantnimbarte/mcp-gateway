import type { BackendState } from "./backend.js";
import type { ProfileConfig } from "./config.js";
import { globMatch } from "./glob.js";

export type DenyReason =
  | "unknown_profile"
  | "server_not_in_profile"
  | "denied_by_policy"
  | "not_allowed"
  | "drift_blocked"
  | "server_unavailable";

export type Decision =
  | { allow: true; rule: string }
  | { allow: false; reason: DenyReason; rule: string };

export interface Facts {
  /** Absent when the profile does not exist. */
  profile: ProfileConfig | undefined;
  /** The owning backend's state. Anything but `up` denies. */
  serverState: BackendState | undefined;
  /** Set by the guard when the tool no longer matches its pin (Phase 4). */
  drifted: boolean;
  onDrift: "block" | "warn";
}

/** The server component of a canonical `<server>__<tool>` name. Server keys contain no `__`. */
export function serverOf(canonical: string): string {
  const i = canonical.indexOf("__");
  return i > 0 ? canonical.slice(0, i) : "";
}

const deny = (reason: DenyReason, rule: string): Decision => ({ allow: false, reason, rule });

/**
 * SPEC §3.1, in that order. Pure, total, and identical for `tools/list` and `tools/call` — a
 * tool the model never saw is still refused if guessed (FR-10). Deny is checked before allow,
 * so an allow entry can never resurrect a denied tool, and any error inside is a DENY.
 *
 * Matching is against the canonical name, never the alias: otherwise renaming a tool would be
 * a way around the deny list (SPEC §3.2).
 */
export function decide(canonical: string, facts: Facts): Decision {
  try {
    const profile = facts.profile;
    if (!profile) return deny("unknown_profile", "no such profile");

    // A name with no `<server>__` prefix belongs to no server, so `*` must not match it either:
    // only names the catalog produced can be allowed.
    const server = serverOf(canonical);
    if (!server) return deny("server_not_in_profile", "not a canonical <server>__<tool> name");
    if (!profile.servers.includes("*") && !profile.servers.includes(server)) {
      return deny("server_not_in_profile", `servers: [${profile.servers.join(", ")}]`);
    }

    const denied = profile.deny.find((glob) => globMatch(glob, canonical));
    if (denied) return deny("denied_by_policy", `deny: ${denied}`);

    let rule = "no allow list";
    if (profile.allow) {
      const allowed = profile.allow.find((glob) => globMatch(glob, canonical));
      if (!allowed) return deny("not_allowed", "matches no allow glob");
      rule = `allow: ${allowed}`;
    }

    if (facts.drifted && facts.onDrift === "block") {
      return deny("drift_blocked", "guard: changed since it was pinned");
    }
    if (facts.serverState !== "up") {
      return deny("server_unavailable", `server is ${facts.serverState ?? "unknown"}`);
    }

    return { allow: true, rule };
  } catch (e) {
    return deny("denied_by_policy", `policy error: ${(e as Error).message}`);
  }
}
