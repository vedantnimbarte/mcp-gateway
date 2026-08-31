# MCP Gateway — Product Requirements

**Status:** Draft for approval · **Date:** 2026-08-31 · **Owner:** Vedant
**Type:** Personal / internal tool. Not a product, not launched, not multi-tenant.

---

## 1. Problem

MCP has no aggregation layer. Every client (Claude Code, Claude Desktop, Cursor, custom agents)
maintains its own list of servers, its own copy of credentials, and its own spawned subprocesses.
That produces four concrete daily problems:

| # | Problem | Today |
|---|---------|-------|
| P1 | **Config sprawl** | The same 8 servers are pasted into 4 different client config files. Adding one means editing all four. |
| P2 | **Process duplication** | Three open clients spawn three copies of every stdio server. Three GitHub connections, 3× memory, 3× rate-limit consumption. |
| P3 | **Tool flooding** | 8 servers × ~15 tools = 120 tools in the model's context. Selection accuracy drops, tokens are wasted, and irrelevant destructive tools stay reachable. |
| P4 | **Zero visibility & zero brakes** | No record of which tool ran with what arguments. A server can silently change a tool's description after you approved it (rug-pull), and nothing notices. No way to say "this client may never call `delete_repository`". |

## 2. What this is

A single local daemon that every MCP client points at instead of pointing at servers directly.
It owns the backend connections once, and exposes curated subsets of their tools as named
**profiles**, each with its own allow/deny policy, rate limit, and audit trail.

## 3. What this is NOT

Explicitly out of scope. Do not build these; do not leave hooks for them.

- **Client authentication.** No OAuth, no OIDC, no API keys, no users, no roles, no RBAC.
  The trust boundary is the local machine (see NFR-2).
- Multi-tenancy, orgs, billing, licensing, public positioning.
- Admin web UI. YAML file + CLI only.
- SIEM export, SOC 2 / HIPAA audit shaping, hash-chained tamper-evident logs.
- A secrets vault. Backend credentials come from environment variables.
- Kubernetes, Helm, horizontal scaling, clustering.
- Being an LLM proxy. It proxies MCP, not model calls. No token/cost accounting.

## 4. Users

One user (you), possibly a second teammate running their own copy. Both roles are the same
person at different times:

- **Operator** — edits `config.yaml`, adds a server, defines a profile, reads the audit log.
- **Consumer** — an MCP client pointed at `http://127.0.0.1:8420/mcp/coding`.

Design consequence: optimise for *edit-a-file-and-restart*, not for runtime API-driven config.

## 5. Goals

| ID | Goal | Measure |
|----|------|---------|
| G1 | One place to declare servers | Adding a server = one YAML block, zero client-config edits |
| G2 | One process per backend regardless of client count | 3 clients connected ⇒ 1 GitHub subprocess |
| G3 | Curated toolsets | A profile can expose 12 tools drawn from 4 backends, renamed |
| G4 | Nothing runs unlogged | Every `tools/call` produces exactly one audit line |
| G5 | Blast-radius control | A deny rule makes a tool unreachable and uncallable, not merely hidden |
| G6 | Detect silent tool changes | A backend altering a tool description after pinning is blocked and reported |

## 6. Functional requirements

### 6.1 Aggregation & routing

- **FR-1** Connect to N backend MCP servers declared in config, over `stdio`, Streamable HTTP, or legacy SSE.
- **FR-2** Spawn and supervise `stdio` backends as child processes: start on daemon boot, restart with exponential backoff on unexpected exit, cap retries, kill cleanly on shutdown.
- **FR-3** Serve MCP over Streamable HTTP at `/mcp/<profile>`. One daemon, many profiles, many concurrent sessions.
- **FR-4** Ship a thin `mcpgw-bridge` stdio binary so stdio-only clients can reach the daemon without spawning their own backends.
- **FR-5** Multiplex: many client sessions share one backend connection. Fan requests in, fan notifications out.
- **FR-6** Proxy `tools`, `resources`, and `prompts`. Relay `notifications/*`. Pass through server-initiated `sampling/createMessage`, `elicitation/create`, and `roots/list` to the originating session.
- **FR-7** Namespace every backend capability as `<server>__<name>` to avoid collisions.

### 6.2 Profiles & policy

- **FR-8** A profile selects a set of servers, then filters their tools by glob `allow` / `deny` lists. Deny beats allow. If `allow` is present, non-matching tools are excluded.
- **FR-9** A profile may `rename` an exposed tool to a shorter or clearer alias.
- **FR-10** Filtering applies to **both** `tools/list` (hidden) and `tools/call` (rejected). A tool the model never saw is still refused if guessed.
- **FR-11** Per-profile rate limits: requests per minute and max concurrent in-flight calls.
- **FR-12** Fail closed. Unknown profile, unknown tool, unparseable policy ⇒ reject.

### 6.3 Guard

- **FR-13** On first sight of a backend tool, record `sha256(name + description + inputSchema)` into `tools.lock.json`.
- **FR-14** On every startup and on every `notifications/tools/list_changed`, re-hash and compare. On mismatch: `block` (default) or `warn`, per config. Blocked tools are removed from listings and refused on call.
- **FR-15** `mcpgw pin` reviews and accepts pending changes, updating the lockfile.
- **FR-16** Redact configured regex patterns from arguments and results before they are written to the audit log.
- **FR-17** Cap tool result size; truncate with an explicit marker rather than forwarding an unbounded payload.

### 6.4 Audit & observability

- **FR-18** Append one JSON object per line to `audit/YYYY-MM-DD.jsonl` for every proxied request, including denials and backend errors.
- **FR-19** Record: timestamp, session, profile, client name/version, server, tool, exposed alias, decision, duration, status, result size, and argument hash (or full args / nothing, per config).
- **FR-20** `mcpgw status` reports backend health, uptime, restart counts, and pending drift.
- **FR-21** `mcpgw tail` streams the audit log in human-readable form.

## 7. Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Single Node process. No database, no Redis, no external services. |
| NFR-2 | **Bind `127.0.0.1` by default. Refuse to bind any non-loopback address unless `listen.token` is set.** Without client auth, port reachability *is* full authority over every configured credential — this interlock is what makes "no auth" safe, and it is not optional. |
| NFR-3 | Backend credentials come from environment variables via `${VAR}` interpolation. Never written to config, never logged, redacted from error messages. |
| NFR-4 | Gateway overhead ≤ 15 ms p95 on top of backend latency for `tools/call`. |
| NFR-5 | A crashed or hanging backend must not take down the daemon or block other backends. Per-call timeout; per-backend isolation. |
| NFR-6 | Cold start to serving ≤ 3 s with 8 stdio backends. Backends connect in parallel; a slow backend does not block the listener. |
| NFR-7 | Total runtime dependencies ≤ 5. |
| NFR-8 | Config is reloadable via `SIGHUP` without dropping live sessions where possible; a changed backend definition restarts only that backend. |

## 8. Success criteria

v1 is done when:

1. All MCP clients on the machine reference only gateway URLs — no direct server entries remain.
2. Backend subprocess count equals the number of configured stdio servers, regardless of how many clients are open.
3. A `readonly` profile demonstrably refuses a write tool that is absent from its listing.
4. Editing a tool's description in a local test server causes the gateway to block it and report drift.
5. A day of normal work produces a queryable audit log: `jq 'select(.decision!="allow")' audit/*.jsonl` returns the denials and nothing else surprises you.

## 9. Assumptions

- Node 24+ available; single machine; macOS/Linux/Windows dev use.
- Backends are largely trusted-but-unverified: the threat model is *accidental damage and silent tool mutation*, not a determined local attacker who already has your shell.
- Client count is single digits; session count is tens.

## 10. Deliberately deferred

Ordered by likely regret. Nothing here blocks v1.

| Deferred | Add when |
|----------|----------|
| SQLite-backed audit | JSONL + `jq` stops answering your questions |
| Read-only web dashboard | You want to look at the log more than once a week |
| Human-in-the-loop approval for high-risk tools | You actually get burned by an auto-approved destructive call |
| Content-based prompt-injection scanning | Description pinning proves insufficient |
| Response caching for idempotent tools | Latency becomes annoying |
| Shared token / mTLS for LAN exposure | You genuinely need it from another machine |
