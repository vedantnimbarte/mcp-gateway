# MCP Gateway — Technical Specification

Implementation contract. Where this disagrees with [ARCHITECTURE.md](./ARCHITECTURE.md),
this document wins. Requirement IDs reference [PRD.md](./PRD.md).

---

## 1. Configuration

### 1.1 File

`config.yaml`, resolved in order: `--config <path>` → `$MCPGW_CONFIG` → `./config.yaml`.

### 1.2 Full example

```yaml
version: 1

listen:
  host: 127.0.0.1        # non-loopback requires `token`
  port: 8420
  # token: ${MCPGW_TOKEN}   # sent as `Authorization: Bearer <token>`

defaults:
  call_timeout_ms: 30000
  connect_timeout_ms: 10000

servers:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
    cwd: ~/
    restart:
      max_retries: 5
      backoff_ms: 1000      # doubles per attempt, capped at 30000

  fs:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/vedant/code"]

  linear:
    transport: http          # Streamable HTTP
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: Bearer ${LINEAR_KEY}

  legacy:
    transport: sse           # deprecated MCP transport, passthrough support only
    url: https://example.com/sse

profiles:
  default:
    servers: ["*"]

  readonly:
    servers: [github, linear]
    allow:
      - "github__get_*"
      - "github__list_*"
      - "github__search_*"
      - "linear__list_*"

  coding:
    servers: [github, fs]
    deny:
      - "github__delete_*"
      - "github__merge_pull_request"
      - "fs__move_file"
    rename:
      github__create_issue: file_bug
      fs__read_text_file: read_file
    limits:
      rpm: 60
      concurrent: 4

guard:
  pin_tools: true
  on_drift: block            # block | warn
  max_result_bytes: 262144
  redact:
    - "gh[pousr]_[A-Za-z0-9]{16,}"
    - "sk-[A-Za-z0-9]{20,}"
    - "(?i)bearer\\s+[A-Za-z0-9._~+/-]{20,}"

audit:
  dir: ./audit
  log_args: hashed           # full | hashed | none
  log_results: none          # full | truncated | none
```

### 1.3 Schema (zod)

```ts
const Restart = z.object({
  max_retries: z.number().int().min(0).default(5),
  backoff_ms:  z.number().int().min(100).default(1000),
}).default({});

const Server = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    cwd: z.string().optional(),
    restart: Restart,
  }),
  z.object({
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
    restart: Restart,
  }),
]);

const Profile = z.object({
  servers: z.array(z.string()).default(["*"]),
  allow:   z.array(z.string()).optional(),   // absent = all not denied
  deny:    z.array(z.string()).default([]),
  rename:  z.record(z.string()).default({}), // canonical -> alias
  limits:  z.object({
    rpm:        z.number().int().positive().default(120),
    concurrent: z.number().int().positive().default(8),
  }).default({}),
});

const Config = z.object({
  version: z.literal(1),
  listen: z.object({
    host:  z.string().default("127.0.0.1"),
    port:  z.number().int().min(1).max(65535).default(8420),
    token: z.string().optional(),
  }).default({}),
  defaults: z.object({
    call_timeout_ms:    z.number().int().positive().default(30000),
    connect_timeout_ms: z.number().int().positive().default(10000),
  }).default({}),
  servers:  z.record(Server),
  profiles: z.record(Profile),
  guard: z.object({
    pin_tools:        z.boolean().default(true),
    on_drift:         z.enum(["block", "warn"]).default("block"),
    max_result_bytes: z.number().int().positive().default(262144),
    redact:           z.array(z.string()).default([]),
  }).default({}),
  audit: z.object({
    dir:         z.string().default("./audit"),
    log_args:    z.enum(["full", "hashed", "none"]).default("hashed"),
    log_results: z.enum(["full", "truncated", "none"]).default("none"),
  }).default({}),
});
```

### 1.4 Interpolation and validation rules

- `${VAR}` is substituted from `process.env` in **string values only**, before zod parsing.
  A missing variable is a **fatal** startup error naming the key — never silently empty.
- `~` at the start of `cwd` expands to the home directory.
- Startup aborts, listing every problem at once, if any of:
  - `profiles.*.servers` names a server absent from `servers` (unless `"*"`)
  - `profiles.*.rename` targets a tool not in the profile's post-filter set
  - two renames in one profile collide, or an alias collides with an unrenamed exposed tool
  - an alias fails `^[a-zA-Z0-9_-]{1,128}$`
  - a `redact` pattern is not a valid regex
  - **`listen.host` is not loopback and `listen.token` is unset** (NFR-2)
- `mcpgw validate` runs exactly these checks and exits non-zero on failure.

## 2. Naming

| Rule | Value |
|------|-------|
| Canonical name | `<server>__<original>` — double underscore |
| Charset | `^[a-zA-Z0-9_-]{1,128}$`; any other character in a server or tool name is replaced with `_` |
| Server key | Must itself match `^[a-zA-Z0-9-]{1,48}$` and contain no `__` |
| Truncation | Names over 128 chars are cut to 120 + `_` + first 7 hex of the sha256 of the full name |
| Aliases | Replace the canonical name in `tools/list`; both are recorded in the audit line |

Resources use the same scheme on URIs: `mcpgw://<server>/<original-uri>`. Prompts use
`<server>__<name>`.

## 3. Policy

### 3.1 Decision function

Pure, total, side-effect-free. Identical for `tools/list` and `tools/call` (FR-10).

```
decide(profile, canonicalName) -> Decision

1. profile unknown                       -> DENY  unknown_profile
2. server(canonicalName) not in profile  -> DENY  server_not_in_profile
   (profile.servers contains "*" or the server key)
3. any deny glob matches                 -> DENY  denied_by_policy
4. profile.allow present
     and no allow glob matches           -> DENY  not_allowed
5. tool marked DRIFTED and on_drift=block-> DENY  drift_blocked
6. server state != UP                    -> DENY  server_unavailable
7. otherwise                             -> ALLOW
```

Order is normative. **Deny is checked before allow** — an allow entry can never resurrect a
denied tool. Every step is fail-closed: any error inside `decide` is a DENY.

### 3.2 Glob syntax

`*` matches any run of characters including `__`. `?` matches one. No `**`, no braces, no
character classes, no regex. Matching is case-sensitive against the canonical name (never
the alias — otherwise renaming would be a policy bypass).

### 3.3 Effect on listings

`tools/list` returns only ALLOW tools. Drifted tools under `on_drift: warn` are listed with
`⚠ [unverified change] ` prefixed to their description.

## 4. MCP surface

Gateway ⇄ client protocol version is negotiated normally; the gateway may accept a range and
negotiates independently with each backend.

### 4.1 Client → gateway

| Method | Handling |
|--------|----------|
| `initialize` | Terminated locally. Capabilities = union of the profile's reachable backends, intersected with what the gateway can proxy. Records client name/version for audit. |
| `notifications/initialized` | Consumed |
| `ping` | Answered locally, never forwarded |
| `tools/list` | Served from the catalog; policy-filtered; renames applied. Pagination collapsed — the gateway returns the full filtered set in one page |
| `tools/call` | §5 pipeline |
| `resources/list`, `resources/templates/list` | Merged, namespaced, filtered by profile server membership |
| `resources/read` | URI de-namespaced, routed to owning backend |
| `resources/subscribe` / `unsubscribe` | Forwarded; `notifications/resources/updated` fanned back to subscribing sessions only |
| `prompts/list`, `prompts/get` | As tools |
| `completion/complete` | Routed by the namespaced ref |
| `logging/setLevel` | Recorded per session; applied to gateway output. Not fanned to backends (it would affect other sessions) |
| `notifications/cancelled` | Mapped through the id table; cancellation forwarded to the owning backend |
| anything else | `-32601 Method not found` |

### 4.2 Gateway → client (reverse)

`sampling/createMessage`, `elicitation/create`, `roots/list` and
`notifications/message` / `progress` are routed per ARCHITECTURE §3.2. Unroutable reverse
requests get `-32006` and an audit line with `decision: "unroutable"`.

### 4.3 ID remapping (normative)

```
Client→backend:  allocate monotonic backendId; store
                 { backendId -> { sessionId, clientId, server, tool, t0, timer } }
Backend→client:  look up backendId, emit reply with the stored clientId to the stored session
Timeout:         clear entry, emit -32002 to the client, do NOT reuse the id
Session close:   drop every entry for that session; send `notifications/cancelled` for each
Backend down:    fail every entry for that backend with -32003
```

The map is the only place client and backend id spaces meet. It must be cleared on all four
paths above; leaks here are how a gateway grows a memory leak and a cross-talk bug at once.

## 5. `tools/call` pipeline

```
1. resolve   alias -> canonical -> (server, originalTool)          [unknown -> -32601]
2. policy    decide(profile, canonical)                            [deny -> -32004]
3. limit     bucket.take(profile) && semaphore.acquire(profile)    [reject -> -32005]
4. guard-in  hash check (already in policy step 5) + validate args against inputSchema
                                                                   [invalid -> -32602]
5. dispatch  backend.call(originalTool, args, timeout)             [timeout -> -32002]
6. guard-out redact patterns; if bytes > max_result_bytes, truncate the last text content
             block and append "\n\n[truncated by mcp-gateway: N bytes omitted]"
7. audit     exactly one line, whatever happened
8. release   semaphore, always, in a finally
```

Steps 2 and 3 are ordered deliberately: a denied call must not consume rate-limit budget.

## 6. Tool pinning

### 6.1 Hash

```
sha256( JSON.stringify({ name, description: description ?? "", inputSchema })
        with object keys sorted recursively )
```

Sorted keys because backends do not guarantee key order across restarts; without sorting
every restart looks like drift.

### 6.2 `tools.lock.json`

```json
{
  "version": 1,
  "pinned_at": "2026-08-31T10:04:00Z",
  "servers": {
    "github": {
      "create_issue": { "hash": "sha256:1f3a…", "seen": "2026-08-31T10:04:00Z" },
      "list_issues":  { "hash": "sha256:9b02…", "seen": "2026-08-31T10:04:00Z" }
    }
  }
}
```

### 6.3 Rules

| Situation | Behaviour |
|-----------|-----------|
| Tool absent from lockfile | New tool → auto-pin, log `pinned` |
| Hash matches | Normal |
| Hash differs | Mark DRIFTED; `block` (default) removes it from listings and refuses calls; `warn` lists it flagged. Log `drift`, printing a description diff to stderr |
| Tool in lockfile, absent from server | Log `removed`; entry kept until `mcpgw pin` |
| `pin_tools: false` | Skip entirely |

`mcpgw pin` prints every pending change as a diff and rewrites the lockfile. `--yes` skips
the prompt. There is intentionally no auto-accept-on-drift mode: silent acceptance would
defeat the entire mechanism.

## 7. Audit

One JSON object per line, `audit/YYYY-MM-DD.jsonl` (UTC date), created on demand, opened
append-only.

```json
{
  "ts": "2026-08-31T10:12:44.812Z",
  "id": "01J9X2K7QW",
  "session": "s_7f3a91",
  "profile": "coding",
  "client": { "name": "claude-code", "version": "2.1.0" },
  "method": "tools/call",
  "server": "github",
  "tool": "create_issue",
  "exposed_as": "file_bug",
  "decision": "allow",
  "args_hash": "sha256:7ab1…",
  "dur_ms": 412,
  "status": "ok",
  "result_bytes": 1204,
  "truncated": false
}
```

| Field | Notes |
|-------|-------|
| `decision` | `allow` \| `denied_by_policy` \| `not_allowed` \| `server_not_in_profile` \| `unknown_profile` \| `drift_blocked` \| `server_unavailable` \| `rate_limited` \| `unroutable` |
| `status` | `ok` \| `error` \| `timeout` \| `denied` |
| `args` | Present only when `log_args: full`, post-redaction |
| `args_hash` | Present when `log_args: hashed` — sha256 of canonical JSON |
| `error` | `{ code, message }` on failure, redacted |

Also logged, with `method` set accordingly: `initialize` (session open), `session_close`,
`backend_up`, `backend_down`, `drift`, `pinned`. Writes go through a stream and are never
awaited by the request path.

## 8. Rate limiting

Token bucket per profile: capacity `rpm`, refill `rpm/60` per second, continuous. Plus a
counting semaphore of size `concurrent`. Both are process-wide per profile — **shared across
sessions**, since the limit protects the backend, not the client. Exhausting either returns
`-32005` with `retry_after_ms` in `error.data`.

## 9. Errors

| Code | Meaning | Emitted when |
|------|---------|--------------|
| `-32600` | Invalid request | Malformed JSON-RPC |
| `-32601` | Method not found | Unproxied method, or unknown tool/alias |
| `-32602` | Invalid params | Args fail the backend's `inputSchema` |
| `-32002` | Request timeout | `call_timeout_ms` elapsed |
| `-32003` | Backend unavailable | Server DOWN, or died mid-call |
| `-32004` | Blocked by policy | Any DENY from §3.1 steps 2–5 |
| `-32005` | Rate limited | Bucket or semaphore exhausted |
| `-32006` | Unroutable reverse request | §4.2 |

`error.data` carries `{ reason, server?, tool?, profile?, retry_after_ms? }`. Messages are
run through the redaction patterns before leaving the process. Backend errors are wrapped,
not swallowed: original `code`/`message` land in `error.data.upstream`.

## 10. Transport

### 10.1 HTTP

| Aspect | Behaviour |
|--------|-----------|
| Path | `POST`/`GET`/`DELETE` `/mcp/<profile>`. Unknown profile → `404`. `/healthz` → `200 {status, backends}` |
| Session | `Mcp-Session-Id` response header on initialize; required on subsequent requests. Unknown/expired → `404`, client re-initializes |
| SSE | `GET` opens the server→client stream; resumable via `Last-Event-ID` |
| Termination | `DELETE` ends the session and releases its id-map entries |
| Body limit | 4 MiB; exceeded → `413` |
| Idle expiry | 30 min without traffic → session dropped |
| Token | When `listen.token` is set, every request must carry `Authorization: Bearer <token>`; compared with `timingSafeEqual`. Missing/wrong → `401` |
| Origin | `Origin` header, when present, must be absent, `localhost`, or `127.0.0.1` — blocks DNS-rebinding from a browser tab |

### 10.2 stdio bridge

`mcpgw-bridge --url http://127.0.0.1:8420/mcp/coding [--token …]`

Pipes `StdioServerTransport` ⇄ `StreamableHTTPClientTransport` with no interpretation of
messages. Exits non-zero with a readable message if the daemon is unreachable. Client config:

```json
{ "mcpServers": { "gateway": {
    "command": "npx", "args": ["-y", "mcpgw-bridge", "--url", "http://127.0.0.1:8420/mcp/coding"] } } }
```

## 11. CLI

```
mcpgw start     [--config PATH] [--port N] [--verbose]
mcpgw validate  [--config PATH]         # exit 1 on any config error
mcpgw status    [--json]                # backends, uptime, restarts, drift, sessions
mcpgw pin       [--yes] [--server NAME] # review + accept tool changes
mcpgw tail      [--profile P] [--denied-only] [--follow]
mcpgw list      [--profile P]           # effective exposed tools after policy
```

`mcpgw list` is the debugging workhorse: it answers "why can't the model see this tool"
by printing each tool with its decision and the rule that produced it.

Signals: `SIGHUP` reloads config (restarting only servers whose definition changed);
`SIGTERM`/`SIGINT` drain in-flight calls up to 5 s, then kill children and exit 0.

## 12. Test plan

Pure units, `node:test`, no framework:

- `policy.ts` — the §3.1 table exhaustively: deny-beats-allow, `*` in servers, missing
  profile, drift, glob edge cases, alias never matched by globs.
- `guard.ts` — key-order-independent hashing, drift detection, redaction across chunk
  boundaries, truncation preserving valid content structure.
- `catalog.ts` — collision on identical tool names across servers, name truncation, rename
  collision detection.
- `ratelimit.ts` — refill math over a fake clock, semaphore release on throw.
- `session.ts` — id remap: two sessions both using `id: 1` get their own replies;
  timeout clears the entry; session close cancels in-flight.

One integration test: a fixture stdio MCP server (~30 lines) with two tools, started by the
suite. Asserts end-to-end call, a policy denial, and that mutating a tool description across
a restart triggers a drift block. That last one is the single most valuable test here —
it is the only check that the security-relevant machinery actually fires.
