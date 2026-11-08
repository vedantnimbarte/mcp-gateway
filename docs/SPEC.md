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
  # tls: { cert: ~/certs/gw.pem, key: ~/certs/gw-key.pem }   # HTTPS, for use beyond loopback
  # page_size: 100          # paginate listings; absent = one page
  oauth_callback_port: 8419 # where `mcpgw auth` catches the OAuth redirect

defaults:
  call_timeout_ms: 30000     # restarted by each progress note from the backend...
  connect_timeout_ms: 10000
  max_call_ms: 600000        # ...up to this ceiling, which must be >= call_timeout_ms

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
    limits: { concurrent: 2 }   # per server, on top of each profile's; either bound optional
    cache:                      # opt-in: results of these tools are reused for ttl_ms
      tools: ["read_*", "list_*"]
      ttl_ms: 30000

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
    approve:                 # these wait for a human's yes in the calling client
      - "github__create_pull_request"
      - "fs__write_file"
    limits:
      rpm: 60
      concurrent: 4

  lean:                      # every server, without filling the model's context (§5.1)
    servers: ["*"]
    context:
      tools: lazy            # full | lazy
      handle_bytes: 8192     # absent: results are returned whole, up to max_result_bytes
      code: true             # adds run_code
      code_timeout_ms: 30000

guard:
  pin_tools: true
  on_drift: block            # block | warn
  on_suspicious: warn        # off | warn | block — descriptions that read like injected instructions
  # scan_patterns: ["(?i)bitcoin"]   # added to the built-in ones
  approval_timeout_ms: 120000
  max_result_bytes: 262144
  redact:
    - "gh[pousr]_[A-Za-z0-9]{16,}"
    - "sk-[A-Za-z0-9]{20,}"
    - "(?i)bearer\\s+[A-Za-z0-9._~+/-]{20,}"

audit:
  dir: ./audit
  log_args: hashed           # full | hashed | none
  log_results: none          # full | truncated | none
  durable: false             # true: fsync every line, synchronously
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
    limits: ServerLimits,
    cache: Cache,
    disabled: z.boolean().default(false), // validated, then dropped: no process, no tools
  }),
  z.object({
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
    restart: Restart,
    limits: ServerLimits,
    cache: Cache,
    disabled: z.boolean().default(false),
  }),
]);

const ServerLimits = z.object({
  rpm:        z.number().int().positive().optional(),   // absent = unlimited
  concurrent: z.number().int().positive().optional(),
}).optional();

const Cache = z.object({
  tools:       z.array(z.string()).min(1),              // globs on the backend's tool name
  ttl_ms:      z.number().int().positive().default(60000),
  max_entries: z.number().int().positive().default(500),
}).optional();

const Profile = z.object({
  servers: z.array(z.string()).default(["*"]),
  allow:   z.array(z.string()).optional(),   // absent = all not denied
  deny:    z.array(z.string()).default([]),
  rename:  z.record(z.string()).default({}), // canonical -> alias
  approve: z.array(z.string()).default([]),  // globs on the canonical name (§5 step 4¼)
  arguments: z.array(z.object({              // §5 step 4⅛
    tools: z.array(z.string()).min(1),       // globs on the canonical name
    name:  z.string(),                       // dot path into the arguments
    allow: z.array(z.string()).optional(),
    deny:  z.array(z.string()).default([]),
    as:    z.enum(["text", "path"]).default("text"),
  })).default([]),
  limits:  z.object({
    rpm:        z.number().int().positive().default(120),
    concurrent: z.number().int().positive().default(8),
  }).default({}),
  context: z.object({                        // §5.1
    tools:           z.enum(["full", "lazy"]).default("full"),
    handle_bytes:    z.number().int().positive().optional(),
    code:            z.boolean().default(false),
    code_timeout_ms: z.number().int().positive().default(30000),
  }).default({}),
});

const Config = z.object({
  version: z.literal(1),
  listen: z.object({
    host:  z.string().default("127.0.0.1"),
    port:  z.number().int().min(1).max(65535).default(8420),
    token: z.string().optional(),
    tls:   z.object({ cert: z.string(), key: z.string() }).optional(),
    page_size: z.number().int().positive().optional(),
    oauth_callback_port: z.number().int().min(1).max(65535).default(8419),
    clients: z.array(z.object({              // §10.1: a token per client
      name:     z.string(),                  // ^[a-zA-Z0-9_-]{1,64}$, unique
      token:    z.string().min(16),          // unique, and not listen.token
      profiles: z.array(z.string()).min(1),  // existing profiles, or "*"
    })).default([]),
  }).default({}),
  defaults: z.object({
    call_timeout_ms:    z.number().int().positive().default(30000),
    connect_timeout_ms: z.number().int().positive().default(10000),
    max_call_ms:        z.number().int().positive().default(600000),
  }).default({}),
  servers:  z.record(Server),
  profiles: z.record(Profile),
  guard: z.object({
    pin_tools:        z.boolean().default(true),
    on_drift:         z.enum(["block", "warn"]).default("block"),
    on_suspicious:    z.enum(["off", "warn", "block"]).default("warn"),
    scan_patterns:    z.array(z.string()).default([]),
    max_result_bytes: z.number().int().positive().default(262144),
    redact:           z.array(z.string()).default([]),
    approval_timeout_ms: z.number().int().positive().default(120000),
  }).default({}),
  audit: z.object({
    dir:         z.string().default("./audit"),
    log_args:    z.enum(["full", "hashed", "none"]).default("hashed"),
    log_results: z.enum(["full", "truncated", "none"]).default("none"),
    durable:     z.boolean().default(false),
  }).default({}),
});
```

### 1.4 Interpolation and validation rules

- `.env` beside the config, when present, is read first (Node's `util.parseEnv`); a variable
  already in the environment is never overridden by it.
- `${VAR}` is substituted from `process.env` in **string values only**, before zod parsing.
  A missing variable is a **fatal** startup error naming the key — never silently empty.
- `~` at the start of `cwd` expands to the home directory.
- Startup aborts, listing every problem at once, if any of:
  - `profiles.*.servers` names a server absent from `servers` (unless `"*"`)
  - `profiles.*.rename` targets a tool not in the profile's post-filter set
  - two renames in one profile collide, or an alias collides with an unrenamed exposed tool
  - an alias fails `^[a-zA-Z0-9_-]{1,128}$`
  - an alias is one of the gateway's own tool names (§5.1): `search_tools`, `describe_tool`,
    `call_tool`, `query_result`, `run_code`
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
5b. tool marked SUSPICIOUS
     and on_suspicious=block             -> DENY  suspicious_blocked
6. server state != UP                    -> DENY  server_unavailable
7. otherwise                             -> ALLOW
```

Prompts go through the same function, with their own drift and suspicious marks (§6).
Approval (`profiles.*.approve`) is deliberately not a step here: an approve-listed tool is
allowed, listed and callable, and the question is put to a human at call time (§5).

Order is normative. **Deny is checked before allow** — an allow entry can never resurrect a
denied tool. Every step is fail-closed: any error inside `decide` is a DENY.

### 3.2 Glob syntax

`*` matches any run of characters including `__`. `?` matches one. No `**`, no braces, no
character classes, no regex. Matching is case-sensitive against the canonical name (never
the alias — otherwise renaming would be a policy bypass).

### 3.3 Effect on listings

`tools/list` returns only ALLOW tools. Drifted tools under `on_drift: warn` are listed with
`⚠ [unverified change] ` prefixed to their description, and suspicious ones under
`on_suspicious: warn` with `⚠ [suspicious content] `. `prompts/list` does the same.

## 4. MCP surface

Gateway ⇄ client protocol version is negotiated normally; the gateway may accept a range and
negotiates independently with each backend.

### 4.1 Client → gateway

| Method | Handling |
|--------|----------|
| `initialize` | Terminated locally. Capabilities = union of the profile's reachable backends, intersected with what the gateway can proxy. Records client name/version for audit. |
| `notifications/initialized` | Consumed |
| `ping` | Answered locally, never forwarded |
| `tools/list` | Served from the catalog; policy-filtered; renames applied. One page by default. With `listen.page_size` every list (`tools`, `prompts`, `resources`, `resources/templates`) is paged; a cursor names an offset and a digest of the listing it came from, and a stale or malformed one is `-32602` |
| `tools/call` | §5 pipeline. In a profile with `context` set, the gateway's own tools are answered first (§5.1) |
| `resources/list`, `resources/templates/list` | Merged, namespaced, filtered by profile server membership |
| `resources/read` | URI de-namespaced, routed to owning backend |
| `resources/subscribe` / `unsubscribe` | Forwarded; `notifications/resources/updated` fanned back to subscribing sessions only |
| `prompts/list`, `prompts/get` | As tools |
| `completion/complete` | Routed by the namespaced ref |
| `logging/setLevel` | Recorded per session; applied to gateway output. Not fanned to backends (it would affect other sessions) |
| `notifications/cancelled` | Mapped through the id table; cancellation forwarded to the owning backend |
| anything else | `-32601 Method not found` |

### 4.2 Gateway → client (reverse)

`sampling/createMessage`, `elicitation/create`, `roots/list` and `notifications/message` are
routed per ARCHITECTURE §3.2: to the one session with work outstanding on that backend — any
number of its own calls, of any method. Unroutable reverse requests (no session, or two different
sessions) get `-32006` and an audit line with `decision: "unroutable"`. A routed request carries
the backend's cancellation and is bounded by `call_timeout_ms`.

`notifications/progress` is forwarded for `tools/call`, `resources/read`, `prompts/get` and
`completion/complete`. Unlike a reverse request it needs no guess: the gateway registers a
progress handler on each backend request, the SDK delivers the backend's progress to that
request's handler by its own id, and the handler re-sends it under the client's own
`progressToken` on the client request's stream. The gateway asks every backend call for
progress, whether or not the client did; a client that sent no token receives none.

Progress also proves a call alive: each note restarts `call_timeout_ms`, up to
`defaults.max_call_ms` in total. Either expiring is `-32002`.

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
3. limit     profile bucket + semaphore, then the server's (§8)    [reject -> -32005]
4. guard-in  hash check (already in policy step 5) + validate args against inputSchema
                                                                   [invalid -> -32602]
4⅛. args     every `arguments` rule whose tools glob matches: each value of its argument (each
             element of an array; `as: path` first turns `\` into `/` and collapses `.`/`..`)
             must match no deny glob and, if there is an allow list, one allow glob
                                              [refused -> -32004 argument_denied]
4¼. approve  if an approve glob matches the canonical name, ask a person in two places and take
             the first answer: the calling client, with `elicitation/create`, and, when
             `listen.token` is set, the status page (`GET /approvals`, answered by
             `POST /approvals/<id>/approve|deny`). Redacted arguments, ≤ 2 KB. Waits up to
             `approval_timeout_ms`. A yes continues, and the audit line carries
             `approved: true` and `approved_via: client|status_page`
                                    [no/timeout/cancelled -> -32004 approval_denied]
                      [client cannot elicit, no token -> -32004 approval_unavailable]
4½. cache    a server that caches this tool answers a repeat from its cache: audited with
             `cached: true`, then straight to step 8
5. dispatch  backend.call(originalTool, args, timeout)             [timeout -> -32002]
6. guard-out redact patterns; if bytes > max_result_bytes, truncate the last text content
             block and append "\n\n[truncated by mcp-gateway: N bytes omitted]"; a cacheable,
             non-error result is stored as it leaves this step. A caller that keeps the
             result out of the model's context (§5.1) cuts at 8 MiB instead; the cache still
             stores the max_result_bytes cut, so no other caller ever receives more
7. audit     exactly one line, whatever happened
8. release   semaphores, always, in a finally
```

Steps 2 and 3 are ordered deliberately: a denied call must not consume rate-limit budget. The
cache comes after both policy and validation, so a cached answer can never bypass either; its key
includes the tool's hash, so a drifted tool never answers from its old self. Cache hits do spend
rate budget.

### 5.1 Context economy (`profiles.*.context`)

Three independent switches. Each one only reshapes what reaches the model. Every backend call
they make is a §5 pipeline call under the session's own profile, so policy, approval, limits,
redaction and audit apply unchanged.

**`tools: lazy`.** `tools/list` returns the gateway's own tools instead of the profile's:

| Tool | Arguments | Returns |
|------|-----------|---------|
| `search_tools` | `query?`, `limit?` (default 20, max 200) | One line per match, `name — first sentence of description`, highest score first. A term in the name scores 3 and one in the description scores 1; an empty query lists every tool |
| `describe_tool` | `names[]` | `{ tools: [{ name, description, inputSchema, outputSchema? }], missing? }` |
| `call_tool` | `name`, `arguments?` (absent = `{}`) | The tool's result, through §5 |

Both list only ALLOW tools (§3.3), under their exposed names. A tool may still be called by its
own name in a lazy profile.

**`handle_bytes`.** A result whose serialized size exceeds it is kept in the session and replaced
by a text summary: the handle id (`r1`, `r2`, …), its bytes and token estimate (bytes / 4), a
shape sketch, up to three preview items, and how to query it. Error results are kept too, and
the summary keeps `isError`. What is kept is the result's value: `structuredContent` if
present, else the joined text parsed as JSON, else that text, else the content blocks. The
store holds 64 handles and 64 MiB per session, evicting the oldest, and goes with the session.
A tool with an `outputSchema` called by its own name is exempt and is capped as usual, since
its client expects the structured content.

`query_result(handle, path?, where?, contains?, fields?, offset?, limit?)`:

```
1. path      dot path into the value ("data.items", "items.0.owner"); missing -> -32602
2. text      a string becomes its list of lines
3. non-list  returned, projected by `fields`; if over handle_bytes, its shape instead
4. where     keep items whose value at each key path equals the given JSON value
5. contains  keep items whose JSON (or line) contains the string, case-insensitively
6. page      offset (default 0), limit (default 20, max 200), then `fields` projection
7. fit       drop items from the end until the reply is ≤ handle_bytes
-> { total, offset, returned, items, next_offset? }
```

An unknown or evicted handle is `-32602`.

**`code: true`.** `run_code(code)` runs `code` as the body of an async function in a child
process started with `node --permission`, no `--allow-*` flags and an empty environment. That
means no file system, no child processes, no workers, no addons, and none of the daemon's
credentials. The script receives `tools`:

- `await tools.call(name, args)` is a §5 call over IPC. It returns `structuredContent`, else
  the text parsed as JSON, else the text. An error result throws.
- `await tools.search(query)` returns `[{ name, description }]` as `search_tools` would.

The reply is the script's console output (at most 1 MiB; later lines are counted, not kept),
then `returned: <JSON>` if it returned something. A throw is an `isError` reply carrying the
output and the error. The child is killed at `code_timeout_ms` (an `isError` "timed out"), on
client cancellation, or when it finishes. The reply then goes through `handle_bytes` like any
result, or without handles is cut at `max_result_bytes`. Inside the sandbox, results are cut
at 8 MiB rather than `max_result_bytes`.

The permission model on Node 22–24 does not restrict the network.

## 6. Tool pinning

### 6.1 Hash

```
sha256( JSON.stringify({ name, description: description ?? "", inputSchema })
        with object keys sorted recursively )
```

Sorted keys because backends do not guarantee key order across restarts; without sorting
every restart looks like drift.

Prompts are pinned the same way, hashing `{ name, description ?? "", arguments ?? [] }`.

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
  },
  "prompts": {
    "github": {
      "review_pr": { "hash": "sha256:5c1e…", "seen": "2026-08-31T10:04:00Z" }
    }
  }
}
```

Each pin also records its `description`, so `mcpgw pin` can show a diff, and `approved: true` once
a human has accepted that exact hash despite the content scan. `prompts` is optional: a lockfile
written before prompts were pinned simply pins them on first sight.

### 6.3 Rules

| Situation | Behaviour |
|-----------|-----------|
| Tool absent from lockfile | New tool → auto-pin, log `pinned` |
| Hash matches | Normal |
| Hash differs | Mark DRIFTED; `block` (default) removes it from listings and refuses calls; `warn` lists it flagged. Log `drift`, printing a description diff to stderr |
| Tool in lockfile, absent from server | Log `removed`; entry kept until `mcpgw pin` |
| Content scan finds something | Mark SUSPICIOUS, whether the tool is new or changed; `warn` (default) lists it flagged, `block` refuses it, `off` skips the scan. Log `suspicious` with the findings |
| `pin_tools: false` | Skip entirely, scan included |

The content scan runs on every review, over every string a tool or prompt shows the model:
description, title, and every string in its `inputSchema` or `arguments`. It looks for
instruction overrides ("ignore previous instructions"), concealment ("do not tell the user"),
hidden directive tags (`<IMPORTANT>`), invisible and bidi-control characters, credential paths
(`id_rsa`, `.ssh/`) and exfiltration phrasing ("send … to https://"), plus any
`guard.scan_patterns`. These are heuristics, and a hit is a reason for a human to look. Only
`mcpgw pin` of that exact hash clears it.

`mcpgw pin` prints every pending change — drift as a diff, findings as a list — and rewrites
the lockfile. `--yes` skips the prompt, and then asks a running daemon to reload: a reload
re-reads the lockfile and unblocks exactly the changes it now records. An unreadable lockfile on
reload keeps the pins in memory — believing an empty one would re-pin every drifted tool as new.
There is intentionally no auto-accept-on-drift mode: silent acceptance would defeat the entire
mechanism.

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
| `decision` | `allow` \| `denied_by_policy` \| `not_allowed` \| `server_not_in_profile` \| `unknown_profile` \| `drift_blocked` \| `suspicious_blocked` \| `argument_denied` \| `approval_denied` \| `approval_unavailable` \| `server_unavailable` \| `rate_limited` \| `unroutable` |
| `approved` | `true` when a human approved the call before it ran; `approved_via` says where: `client` or `status_page` |
| `client_key` | The `listen.clients` key the session was opened with, if any |
| `status` | `ok` \| `error` \| `timeout` \| `denied` |
| `args` | Present only when `log_args: full`, post-redaction |
| `args_hash` | Present when `log_args: hashed` — sha256 of canonical JSON |
| `cached` | `true` when a `tools/call` was answered from the response cache |
| `error` | `{ code, message }` on failure, redacted |

Also logged, with `method` set accordingly: `handle` (a result kept out of context, with its
`handle` id and `result_bytes`), `run_code` (one per script, `args_hash` of the code
under the usual `log_args` rule, `status` ok|error|timeout; each tool it calls has its own
`tools/call` line), `initialize` (session open), `session_close`,
`backend_up`, `backend_down`, `drift`, `pinned`, `suspicious`, `tree_unlisted` (closing a backend could not list its child processes, so one may have leaked), and `manage` for every reload,
restart, stop or config change requested over HTTP — `{ action, status: ok|error, remote, server?, profile?, tool?, problems? }`, where `action` is `reload`, `restart`, `stop`, `disable_server`, `enable_server`, `disable_tool`, `enable_tool` or `edit_config`. A refusal is a request too: a
resource URI that is malformed or outside the profile gets its line like a denied tool call.
Writes go through a stream and are never awaited by the request path. Under `audit.durable`
each line is instead appended and fsynced synchronously, surviving a crash at the cost of a
blocking flush per request.

## 8. Rate limiting

Token bucket per profile: capacity `rpm`, refill `rpm/60` per second, continuous. Plus a
counting semaphore of size `concurrent`. Both are process-wide per profile — **shared across
sessions**, since the limit protects the backend, not the client. Exhausting either returns
`-32005` with `retry_after_ms` in `error.data`.

A server with `limits` has a bucket and semaphore of its own, shared by every profile that reaches
it, so one busy backend cannot starve the others. A call takes its profile's first and then its
server's; a server refusal (`error.data.server` set) hands the profile its slot back, though not
its token. Changing a server's `limits` or `cache` on reload does not restart its process.

Buckets are written to `ratelimit.state.json` beside the config on graceful shutdown and restored
on start, so restarting the daemon is not a way to refill them. A bucket whose `rpm` changed in
between starts full. A crash skips the write.

The budget covers every method that makes a backend do work: `tools/call`, `resources/read`,
`prompts/get` and `completion/complete`. `resources/subscribe` and `unsubscribe` are exempt —
they are bookkeeping, and refusing an unsubscribe would strand the backend subscription the
session had already released.

## 9. Errors

| Code | Meaning | Emitted when |
|------|---------|--------------|
| `-32600` | Invalid request | Malformed JSON-RPC |
| `-32601` | Method not found | Unproxied method, or unknown tool/alias |
| `-32602` | Invalid params | Args fail the backend's `inputSchema` |
| `-32002` | Request timeout | `call_timeout_ms` elapsed without progress, or `max_call_ms` elapsed |
| `-32003` | Backend unavailable | Server DOWN, or died mid-call |
| `-32004` | Blocked by policy | Any DENY from §3.1 steps 2–5b, or an approval refused or impossible (§5 step 4¼) |
| `-32005` | Rate limited | Bucket or semaphore exhausted |
| `-32006` | Unroutable reverse request | §4.2 |

`error.data` carries `{ reason, server?, tool?, profile?, retry_after_ms? }`. Messages are
run through the redaction patterns before leaving the process. Backend errors are wrapped,
not swallowed: original `code`/`message` land in `error.data.upstream`.

## 10. Transport

### 10.1 HTTP

| Aspect | Behaviour |
|--------|-----------|
| Client keys | Each `listen.clients` entry's token opens `/mcp/<profile>` for its own `profiles` only (another profile → `403`, audited as `forbidden`) and nothing else: not `/healthz` detail, the status page's data, or any management route. `listen.token` still opens every profile. With any client key configured, `/mcp/` requires a token even on loopback. A session is bound to the key that opened it; a request on it with another key is `404`. Keys are read per request, so a reload applies them |
| Approvals | `GET /approvals` (detail) lists calls waiting for a person: `{ approvals: [{ id, profile, tool, canonical, rule, args, client, client_key, session, since, until }], can_answer }`. `POST /approvals/<id>/approve\|deny` is gated like `/stop`: it needs `listen.token` set and presented, so a model's own HTTP tool cannot approve its call. A call no longer waiting is `404`. Each answer leaves a `manage` line (`approve_call`, `deny_call`) |
| Path | `POST`/`GET`/`DELETE` `/mcp/<profile>`. Unknown profile → `404`. `POST /reload` re-reads the config; `POST /restart/<server>` reconnects one backend. `POST /stop` answers `202` and then drains and exits like `SIGTERM`; it needs `listen.token` to be set (else `403`) as well as the token itself. So do `POST /servers/<name>/disable|enable` (sets `disabled: true|false`) and `POST /profiles/<p>/tools/<server>__<tool>/disable|enable` (adds or removes that exact entry in the profile's `deny`). Those two write `config.yaml` and reload: the edit is spliced into the text so comments and layout survive, re-parsed and checked to mean exactly the intended change, validated like a load, and written via a temp file and rename with the previous file kept as `config.yaml.bak`. Invalid result → `400` with `problems`; a layout the splice cannot change safely → `409`; either way the file is untouched. Config changes and reloads run one at a time. The raw editor is `GET /config` (`{ path, text, hash }`, the file as written), `POST /config/validate` with `{ text }` (`200 { status: valid, restart_needed }` or `400 { problems }`) and `PUT /config` with `{ text, base_hash }`: the text is validated like a load and written the same way, and a `base_hash` that no longer matches the file on disk is `409` so a change made elsewhere is never overwritten. These three answer only requests whose socket address is loopback, on top of the token (else `403`), since writing `command:` runs a program as the daemon's user. A save answers `{ hash, restart_needed }`; `restart_needed` means the `listen` block changed, which is saved but applies only when the daemon is started again. `GET /profiles/<p>/tools` returns each tool's decision, rule and `toggle` (`disable`, `enable` or `null`); it is detail like `/healthz`, so it needs the token only when one is set. `GET /audit/recent?n=&denied=1` returns the newest audit lines (token-gated, `n` ≤ 1000, tail of the newest file only) |
| Status page | `GET /` and `/dashboard.js`: static, no data, no token needed. Six views, each at its own fragment (`#/overview`, `#/traffic`, `#/backends`, `#/tools`, `#/activity`, `#/config`), each fetching only what it shows, `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`. `GET /dashboard` answers `308` to `/`. The page fetches `/healthz`, `/audit/stats` and `/audit/recent` with a token the viewer types in, kept in `sessionStorage`. `GET /audit/stats?window=1h\|24h\|7d` (token-gated, default `24h`, anything else `400`) counts the JSONL log over the window: `totals` (calls, ok, refused, errors, timeouts, cached, approved, bytes, sessions, run_code, handles, kept_bytes), `latency` p50/p95/p99 of successful calls, a `series` of 12, 24 or 28 buckets, the top `tools`, every `servers` and `profiles` row (calls, errors, refused, p95, bytes), `clients`, refusal `reasons`, and `live` calls per server in the last minute. It reads at most the newest 32 MB of log (`partial: true` when it stopped there), and the answer is reused for 4 s. The authorized `/healthz` also reports `version`, `node`, `pid`, `memory_mb`, `listen`, each backend's `transport`, and `profile_detail` (servers, visible tools, sessions, and `context` when set). When the authorized `/healthz` reports `manage: true` (a token is set), it offers reload, per-backend restart, disable and enable, per-profile tool toggles, stop, and — when `/healthz` also reports `editor: true` (the request came from this machine) — the YAML editor, calling the routes above |
| TLS | With `listen.tls: { cert, key }` (PEM paths, `~` expanded) the listener is HTTPS. Binding beyond loopback without it logs `insecure_lan` at startup — allowed, since the token is required, but the token then crosses the network in the clear |
| `/healthz` | `200 {status}` always; the `{uptime_s, sessions, pending_drift, backends}` detail only when the request is authorized, since it names backends and pids |
| Session | `Mcp-Session-Id` response header on initialize; required on subsequent requests. Unknown/expired → `404`, client re-initializes |
| SSE | `GET` opens the server→client stream. Resumable: every event carries an id, and a client that lost a stream reconnects with `Last-Event-ID` to receive what it missed. Kept per session in memory, the last 256 events or 4 MiB; an evicted or unknown id is `400` and the client re-initializes |
| Termination | `DELETE` ends the session and releases its id-map entries |
| Body limit | 4 MiB; exceeded → `413` |
| Idle expiry | 30 min with no request open and none arriving → session dropped. An open GET stream or a long call is not idle |
| Token | When `listen.token` is set, every request must carry `Authorization: Bearer <token>`; compared with `timingSafeEqual`. Missing/wrong → `401`, and an audit line `{ method: "unauthorized", path, remote }` |
| Origin | `Origin` header, when present, must be `localhost` or `127.0.0.1` — blocks DNS-rebinding from a browser tab. With `listen.token` set, an `Origin` whose host equals the request's own `Host` is accepted too, so the status page served under a LAN name can POST; a rebound page could match it, but holds no token. Checked **first**, before the token and before `/healthz`, so no route answers a browser tab |
| Host | Without `listen.token`, the `Host` header must name a loopback host, else `403`. Covers the rebinding case `Origin` cannot: a browser omits `Origin` on a same-origin GET, and a rebound page is same-origin with itself. With a token set any Host is accepted — LAN names are legitimate, and detail is token-gated |

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
mcpgw start     [--config PATH] [--port N] [--verbose]   # -v mirrors audit lines to stderr
mcpgw validate  [--config PATH]         # exit 1 on any config error
mcpgw status    [--json]                # backends, uptime, restarts, drift, sessions
mcpgw pin       [--yes] [--server NAME] # review + accept tool changes
mcpgw tail      [--profile P] [--denied-only] [--follow]
mcpgw query     SQL [--json]            # SQL over the audit log; table `audit`, see below
mcpgw list      [--profile P]           # effective exposed tools after policy
mcpgw reload                            # re-read the config in the running daemon
mcpgw restart   SERVER                  # reconnect one backend in the running daemon
mcpgw auth      SERVER [--reset] [--print-url]
mcpgw init      [--profile P] [--clients] [--yes]   # import client configs; dry run without --yes
mcpgw service   install|uninstall|status [--name N] [--dry-run]
```

`mcpgw start --log FILE` appends its output to a file, for a service with no terminal.

`mcpgw init` reads the user-wide `mcpServers` of Claude Desktop, Cursor, Claude Code
(`~/.claude.json`) and Windsurf. Each entry with a `command` becomes a `stdio` server, and each
with a `url` (or `serverUrl`) becomes `http`, or `sse` when its `type` says so. Entries that are
disabled, have neither, or already point at this gateway are skipped. The same server (same
command and args, or URL) found twice is imported once, under the first client's name made safe
(`My Files` → `my-files`), suffixed `-2` on a clash. Every `env` and header value that is not
already a `${VAR}` moves into `.env` beside the config, named after its own key (a header is
prefixed with its server); a clash with a different value takes the server's name in front. An
existing config is merged with the YAML document API, so comments survive, and only gains servers
and a missing profile. The merged config is validated before anything is written; writes go
`.env`, then `config.yaml` (previous kept as `.bak`), then with `--clients` each client file
(previous kept as `.mcpgw-backup`), whose imported entries are replaced by one entry for the
gateway: `{ type: "http", url }` for Claude Code, the bridge for the others. With `listen.token`
or client keys configured, client files are left alone rather than given a token.

`mcpgw service install` writes, then starts: a launchd agent (`~/Library/LaunchAgents/dev.mcpgw.<name>.plist`,
`launchctl bootstrap gui/<uid>`) on macOS, a systemd user unit (`~/.config/systemd/user/<name>.service`,
`enable --now`) on Linux, and on Windows a `<name>.vbs` in the user's Startup folder that runs
`node cli.js start` hidden. Each runs `start --config <path> --log <dir>/mcpgw.log`. No step needs
administrator rights. `uninstall` stops it (`bootout`, `disable --now`, or on Windows `POST /stop`
then the pid `/healthz` reports) and removes the file.

`mcpgw restart` is the only way back for a backend that exhausted its retries or that was DOWN
awaiting `mcpgw auth`: `reload` deliberately skips any server whose definition has not changed,
which is exactly those two cases.

`mcpgw list` is the debugging workhorse: it answers "why can't the model see this tool"
by printing each tool with its decision and the rule that produced it.

`mcpgw query` runs one SQL statement over the audit log. It keeps `index.sqlite` in the audit
directory, built with the built-in `node:sqlite` and caught up incrementally from each JSONL
file's last complete line. Table `audit` has `id, ts, session, profile, client_name, method,
server, tool, exposed_as, decision, status, dur_ms, result_bytes` and `line`, the original JSON,
for `json_extract`. The statement runs on a read-only connection. The index is derived and
disposable; the daemon never reads or writes it.

`http`/`sse` servers with `auth: oauth` take `oauth_grant: authorization_code` (default; the
browser flow, once, via `mcpgw auth`) or `client_credentials` (requires `client_id` and
`client_secret`; the daemon fetches its own tokens and `mcpgw auth` has nothing to do).

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
- `context.ts` — lazy listing; search and describe hide denied tools; a large result becomes a
  handle under `handle_bytes` that `query_result` filters and pages without exceeding it;
  handles are per session; `run_code` returns only its output, obeys policy, cannot read files,
  spawn processes or see the environment, and is killed at its timeout.

One integration test: a fixture stdio MCP server (~30 lines) with two tools, started by the
suite. Asserts end-to-end call, a policy denial, and that mutating a tool description across
a restart triggers a drift block. That last one is the single most valuable test here —
it is the only check that the security-relevant machinery actually fires.
