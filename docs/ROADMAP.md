# MCP Gateway — Build Order

Six phases. Each ends with something runnable and a check that fails if the phase regresses.
Estimates assume one person, part-time. Total ≈ 3 weeks of focused work.

Do not start a phase before the previous one's exit criteria pass. The ordering is chosen so
the riskiest unknown (multiplexing correctness) is hit in Phase 2, not Phase 5.

---

## Phase 0 — Skeleton · ~half a day

Scaffold, config loading, no protocol yet.

- `package.json` (Node 22.13+, ESM, `"type": "module"`), `tsconfig.json`, `.gitignore` (`audit/`, `node_modules`)
- Deps: `@modelcontextprotocol/sdk`, `yaml`, `zod`. Nothing else.
- `config.ts` — load, `${ENV}` interpolate, zod parse, all SPEC §1.4 cross-checks
- `cli.ts` — `parseArgs`, `validate` subcommand only

**Exit:** `mcpgw validate` accepts the SPEC §1.2 sample and exits 1 with a readable message
on each of: missing env var, unknown server in a profile, rename collision, non-loopback host
without a token.

---

## Phase 1 — One backend, one profile, no policy · ~2 days

The end-to-end spine. Prove the SDK wiring before adding anything clever.

- `backend.ts` — connect one stdio server, handshake, `tools/list`, `tools/call`
- `server.ts` — `node:http`, loopback interlock, `/mcp/<profile>`, SDK `StreamableHTTPServerTransport`
- `session.ts` — create/lookup by `Mcp-Session-Id`, id remapping (SPEC §4.3)
- Hardcode: all tools exposed, no filtering, no limits

**Exit:** Claude Code connects to `http://127.0.0.1:8420/mcp/default`, lists the filesystem
server's tools, and successfully reads a file through the gateway.

> The interlock lands here, not later. It is three lines and it is the thing standing between
> "no auth" and "every credential exposed to the LAN" — retrofitting security is how it gets
> forgotten.

---

## Phase 2 — Multiple backends, multiple sessions · ~3 days

The hard part. Everything after this is comparatively mechanical.

- `pool.ts` — N backends connected in parallel, each with its own timeout
- `catalog.ts` — namespacing, merge, collision handling, name truncation
- Bind listener **before** backends finish connecting; emit `list_changed` as they arrive
- Notification fan-out to affected sessions only (ARCHITECTURE §3.3)
- Reverse-request routing + `-32006` for the unroutable case (§3.2)
- Supervision: restart with backoff, DOWN state, fail in-flight with `-32003`

**Exit:** two clients connected simultaneously, four backends configured, one of them
deliberately crashed. Neither client is disturbed, the crashed backend's tools vanish and
return on restart, and `ps` shows exactly four backend processes.

**Watch for:** replies delivered to the wrong session. Write the two-sessions-both-using-`id:1`
test here and keep it.

---

## Phase 3 — Profiles and policy · ~2 days

The reason the project exists.

- `policy.ts` — pure `decide()`, SPEC §3.1 order exactly
- Glob matcher (~10 lines; no dependency)
- Apply to `tools/list` **and** `tools/call`
- Renames, with collision detection at config load
- `ratelimit.ts` — token bucket + semaphore
- `mcpgw list --profile P` showing each tool's decision and the rule behind it

**Exit:** the `readonly` profile lists 11 tools where `default` lists 60; calling a denied
tool by its exact canonical name returns `-32004`; a rename is invisible to the deny glob.
`policy.ts` unit tests cover the full decision table.

---

## Phase 4 — Guard and audit · ~2 days

- `guard.ts` — sorted-key hashing, `tools.lock.json`, drift detection, redaction, size caps
- `audit.ts` — JSONL append, date rotation, stream writes off the request path
- `mcpgw pin` with description diffs; `mcpgw tail`
- Arg validation against the backend `inputSchema`

**Exit:** editing a tool description in the fixture server and restarting produces a blocked
tool, a `drift` audit line, and a readable diff on stderr. `mcpgw pin --yes` clears it. A day
of real use leaves a log where `jq 'select(.decision!="allow")' audit/*.jsonl` is informative.

---

## Phase 5 — Bridge, polish, cutover · ~2 days

- `bridge.ts` — stdio ⇄ HTTP shim, clear error when the daemon is down
- `mcpgw status`, `/healthz`
- `SIGHUP` reload restarting only changed servers; `SIGTERM` graceful drain
- Integration test (SPEC §12) wired into `npm test`
- README with the three client-config snippets
- **Cutover:** replace every direct server entry in every client config with a gateway URL

**Exit:** all five PRD §8 success criteria pass.

---

# After cutover: Phases 6–10

Planned 2026-09-14. Three triggers from the deferred table below have fired in real use —
stuck long-running tools and `-32006`s, one backend starving the others, and a risky call /
suspicious description — so those phases come first. Constraints unchanged: stdlib and the
existing three dependencies only.

## Phase 6 — Baseline, drift and real bugs · *done*

- Node baseline raised to 22.13 (`node:sqlite` for Phase 10); CI on 22.13 and 24
- `Host` check closes the DNS-rebinding case `Origin` misses (same-origin GETs carry no `Origin`)
- `mcpgw status` sends the token; the idle sweep spares sessions with a request still open
- Reverse requests: counted per session (two calls from one session no longer orphan each other),
  routed during resource reads, prompt fetches and completions too, and carry cancellation
- Refused resource requests are audited; prompts and completions are size-capped
- `mcpgw pin --yes` reloads a running daemon, which re-reads the lockfile; a reload keeps the
  rate limiter of any profile whose limits did not change

**Exit:** each fix has a test that fails without it.

## Phase 7 — Long-running calls · *done*

- Forward `notifications/progress`: the SDK's per-request `onprogress` already correlates exactly,
  so this was *not* blocked on reverse-request routing as the deferred table below assumed
- Progress restarts `call_timeout_ms`, up to a new `defaults.max_call_ms` (default 10 min). The
  gateway asks every backend call for progress, so this works for clients that never ask for it
- Resumable SSE via a per-session event store, bounded by count and bytes

**Exit:** a long tool shows progress through the gateway and completes past `call_timeout_ms`.

## Phase 8 — Isolation and latency · *done*

- Per-server `limits` reusing `Limiter`, held together with the profile's; changing them on reload
  does not restart the backend
- Opt-in per-server response cache keyed on args + tool hash, so drift invalidates it
- Rate-limit buckets written on graceful shutdown and restored on start
- Process-tree cleanup on every platform: descendants listed before close, survivors killed.
  Replaces the Windows-only `taskkill`, which raced the SDK's own kill
- `mcpgw start --verbose` mirrors audit lines to stderr

**Exit:** a saturated backend does not delay another; a cached call audits `cached: true`.

## Phase 9 — Brakes · *done*

- `profiles.*.approve` globs: the gateway asks the calling client through `elicitation/create`,
  failing closed when the client cannot elicit, declines, dismisses or does not answer
- Heuristic content scanning of tools and prompts (`guard.on_suspicious`), on first sight as well
  as on change, cleared only by `mcpgw pin` of that exact hash
- Prompt pinning, in its own `prompts` section of the lockfile
- Redaction across adjacent text blocks; opt-in `audit.durable`

**Exit:** an approve-listed call is refused unless the human accepts it in the client.

## Phase 10 — Operator tooling and LAN · *done*

- PRD amended to allow a read-only status page, token over TLS, and a CLI-only SQLite index
- `mcpgw query` over a derived `node:sqlite` index of the JSONL; read-only `/dashboard` with a
  token-gated `/audit/recent`
- `listen.tls`, an `insecure_lan` warning without it, and an audit line per refused token
- Configurable OAuth callback port and a `client_credentials` grant; opt-in `listen.page_size`
- Device-code OAuth stays out: no SDK support and no trigger

**Exit:** `mcpgw query` answers what one line of `jq` could not; runtime deps still three.

## Phase 11 — Managing from the status page · *done*

Approved 2026-09-15, in three PRs. Management needs `listen.token`; PRD §3 amended.

- **A (buttons):** reload, restart a backend, and `POST /stop` from `/dashboard`; the page's own
  LAN origin may POST; a `manage` audit line per action
- **B (toggles):** `disabled: true` on a server, per-profile tool deny toggles, written to
  `config.yaml` by splicing text (a yaml round-trip drops comments), verified to mean exactly
  the intended change, with a `.bak`
- **C (editor):** raw YAML editor with validate and save-and-reload, a hash check against
  concurrent edits, loopback requests only,
  since writing `command:` is running a program as you

**Exit:** a backend can be restarted, a tool switched off and the config edited without a shell.

## Phase 12 — Context economy · *done*

Profiles shrink the tool list ahead of time; this phase keeps the context small while it runs.
All of it is in `context.ts` and goes through `Pipeline.callTool`, so nothing bypasses policy.

- `context.tools: lazy`: `search_tools` / `describe_tool` / `call_tool` instead of every schema
- `context.handle_bytes`: oversized results kept per session behind a handle, with shape and
  preview; `query_result` with path, where, contains, fields and paging, bounded by the same size
- `context.code`: `run_code` in a `node --permission` child with an empty environment, tool calls
  back over IPC, killed at `code_timeout_ms` or on cancel, one `run_code` audit line per script
- Gateway tool names are reserved: a rename cannot take one

**Exit:** a 173 KB result comes back under 4 KB, and filtering it in `run_code` returns one
number. The sandbox cannot read the config, spawn processes, or see the daemon's environment.

## Phase 13 — Status page as a dashboard · *done*

- Served at `/`; `/dashboard` redirects
- A live track diagram: backends into the gate, out to profiles, lit by state, weighted by traffic
- `/audit/stats` over 1h, 24h or 7d, counted from the JSONL (the daemon still never opens the
  SQLite index), bounded at 32 MB per read and cached for 4 s
- Traffic ledger and chart, busiest tools, refusal reasons, clients, per-backend latency, and an
  activity log with a refusals-only filter
- `handle` audit lines, so the page can say how much stayed out of the model's context
- Split into six views behind a tab bar (overview, traffic, backends, tools, activity, config),
  each at its own fragment and fetching only what it shows; the tools view groups by backend
  with search and an allowed/blocked filter, so a large catalog stays readable
- Reading `/profiles/<p>/tools` is detail like `/healthz`: no longer refused when no token is
  configured. Switching a tool still needs one

**Exit:** every section fills from a demo gateway's traffic, and the page has no horizontal
scroll at phone width.

## Phase 14 — Moving over, staying up, finer rules · *done*

- `mcpgw init`: imports servers from Claude Desktop, Cursor, Claude Code and Windsurf, once each,
  into `config.yaml` (merged, comments kept) with secrets lifted into `.env`; `--clients` repoints
  each client at the gateway; a dry run without `--yes`, backups of every file it changes
- `.env` beside the config is read on every load; the environment wins over it
- `listen.clients`: a named token per client, limited to its profiles, never the status page's
  detail or controls; `client_key` on every audit line; sessions bound to their key
- `profiles.*.arguments`: allow/deny globs on argument values, with `as: path` normalising first;
  refusals are `argument_denied`
- Approvals race the client's prompt against the status page's Allow and Deny; answering needs
  `listen.token`, so a model's own fetch tool cannot approve its call
- `mcpgw service install|uninstall|status`: launchd agent, systemd user unit, or a hidden
  Startup-folder launcher on Windows; `start --log FILE`

**Exit:** a client key is refused another profile; `/code/../etc` is refused by a `/code/*` rule;
a client that cannot elicit gets its call approved from the status page; `init` run twice adds
nothing the second time; the Windows launcher starts a gateway hidden, with secrets from `.env`.

---

## Sequencing notes

**Build the fixture server in Phase 1.** A ~30-line stdio MCP server with two tools, one of
which can mutate its own description on restart, is the test harness for Phases 2–5. Building
it early costs an hour and saves days of debugging against real servers whose behaviour you
cannot control.

**Do not build `pin` before `hash`.** Obvious, but the temptation is to write the nice CLI
first. The hashing rule (sorted keys, SPEC §6.1) is the part that is easy to get subtly wrong
and silently useless.

**Resources and prompts can slip.** Tools are 95% of the value. If Phase 2 runs long, ship
tools-only and add `resources`/`prompts` after cutover — the catalog abstraction already
accommodates them. *(Done after cutover, as planned: the catalog took them without a rewrite.)*

## Deferred, with triggers

| Item | Build it when |
|------|---------------|
| ~~SQLite audit + `mcpgw query`~~ | *Done in Phase 10, as a derived index* |
| ~~Read-only web dashboard~~ | *Done in Phase 10, at `/dashboard`* |
| mTLS | A shared token over TLS stops being enough |
| ~~Approval prompts for high-risk tools~~ | *Done in Phase 9, through MCP elicitation* |
| ~~Content scanning for injected instructions~~ | *Done in Phase 9, as heuristics* |
| ~~Response cache for idempotent tools~~ | *Done in Phase 8, opt-in per server* |
| ~~Per-server concurrency limits~~ | *Done in Phase 8, with per-server rpm as well* |
| Config hot-reload without SIGHUP | Restarting becomes a genuine irritation — *done in Phase 5: Windows has no SIGHUP, so `POST /reload` and `mcpgw reload` exist* |
| ~~Forwarding `notifications/progress`~~ | *Done in Phase 7. It was never blocked on reverse-request correlation: the SDK routes progress by its own request id* |
| ~~SSE resumability (`Last-Event-ID`)~~ | *Done in Phase 7, in memory and bounded* |
| ~~`mcpgw start --verbose`~~ | *Done in Phase 8* |
| ~~OAuth for `http`/`sse` backends~~ | *Done: `auth: oauth`, `mcpgw auth <server>`, refresh on expiry, and pre-registered clients for servers like Figma that refuse dynamic registration* |

## Known ceilings accepted in v1

Each is a deliberate shortcut with a stated upgrade path. Mark them with `ponytail:` comments
at the relevant code site so they surface later.

| Ceiling | Impact | Upgrade |
|---------|--------|---------|
| Rate limits persisted only on graceful shutdown | A crash resets the buckets | Write them periodically |
| Best-effort audit writes by default | A crash can lose the last few lines | `audit.durable: true` (Phase 9) |
| No session persistence | Restart forces clients to re-initialize | MCP already handles this; leave it |
| Listings are one page by default | A backend with 1000 tools returns one large page | `listen.page_size` (Phase 10) |
| Single process | One core ceiling | Several daemons, each with its own config directory and port (README) |
| Status page's audit view reads today's file only | Just after midnight UTC it shows little | Walk back into the previous file |
| Content scanning is regex heuristics | Catches careless injections, not careful ones | A model-based review |
| Approval waits hold rate-limit slots | A human who walks away holds a slot for `approval_timeout_ms` | Release slots while waiting, re-acquire on yes |
| Process trees are not cleaned up after a crash | A crashed launcher can leave its children | Own the spawn, detached, and signal the process group |
| Response cache evicts oldest-first | A hot key can be evicted | True LRU |
| Result handles live in memory, per session | A handle dies with its session or a restart | Spill to disk beside the audit log |
| `run_code` can reach the network | A script can call out like its client could | `--allow-net` on Node 25+, or a container |
| `/audit/stats` re-reads the log, at most 32 MB | A very busy window is counted from its recent end, marked `partial` | Aggregate as lines are written |
| Path argument rules are case-sensitive and do not resolve symlinks | A link inside an allowed folder can point out of it | `realpath` when gateway and backend share a file system |
| `mcpgw init` reads user-wide client servers only | Per-project servers (`.mcp.json`, Claude Code `projects`) stay in their clients | Import those with a `--project` flag |
| A cache hit is cut at `max_result_bytes` even for a handle | A cached large result is truncated before it is kept | Cache uncapped results for handle profiles |
