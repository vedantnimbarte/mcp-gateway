# MCP Gateway — Build Order

Six phases. Each ends with something runnable and a check that fails if the phase regresses.
Estimates assume one person, part-time. Total ≈ 3 weeks of focused work.

Do not start a phase before the previous one's exit criteria pass. The ordering is chosen so
the riskiest unknown (multiplexing correctness) is hit in Phase 2, not Phase 5.

---

## Phase 0 — Skeleton · ~half a day

Scaffold, config loading, no protocol yet.

- `package.json` (Node 24+, ESM, `"type": "module"`), `tsconfig.json`, `.gitignore` (`audit/`, `node_modules`)
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
accommodates them.

## Deferred, with triggers

| Item | Build it when |
|------|---------------|
| SQLite audit + `mcpgw query` | A `jq` invocation you want takes more than one line |
| Read-only web dashboard | You check the log more than weekly |
| Approval prompts for high-risk tools | An auto-approved destructive call actually burns you |
| Content scanning for injected instructions | Description pinning proves insufficient in practice |
| Response cache for idempotent tools | Latency becomes annoying enough to measure |
| Per-server concurrency limits | One backend starts starving the others |
| Config hot-reload without SIGHUP | Restarting becomes a genuine irritation — *done in Phase 5: Windows has no SIGHUP, so `POST /reload` and `mcpgw reload` exist* |
| OAuth for `http`/`sse` backends | A remote server you actually use needs it. Confirmed blocker for `mcp.figma.com`, which 401s the gateway's static-header connection |

## Known ceilings accepted in v1

Each is a deliberate shortcut with a stated upgrade path. Mark them with `ponytail:` comments
at the relevant code site so they surface later.

| Ceiling | Impact | Upgrade |
|---------|--------|---------|
| In-memory rate limits | Reset on restart | Persist counters if it ever matters |
| Best-effort audit writes | A crash can lose the last few lines | `fsync` per line, at a real throughput cost |
| No session persistence | Restart forces clients to re-initialize | MCP already handles this; leave it |
| `tools/list` pagination collapsed | A backend with 1000 tools returns one large page | Paginate the merged catalog |
| Single process | One core ceiling | Multiple daemons on different ports |
| Drift detection is hash-only | Catches change, not malice on first sight | Content scanning (deferred above) |
