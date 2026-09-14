<p align="center">
  <img src="assets/logo.png" width="440" alt="MCP Gateway">
</p>

<p align="center">
  One local daemon in front of all your MCP servers — curated toolsets, allow/deny policy, and an audit log.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-5FA04E" alt="Node 22.13+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
  <img src="https://img.shields.io/badge/status-in%20development-orange" alt="In development">
</p>

---

Every MCP client keeps its own list of servers, its own copy of your credentials, and its own
spawned subprocesses. Open three clients and you have three GitHub servers running, three
copies of the same config to maintain, and 120 tools competing for space in the model's
context — with no record of which one ran, or with what arguments.

MCP Gateway is a single local daemon that sits in front of all of them. It owns the backend
connections once and exposes curated subsets of their tools as named **profiles**. Clients
connect to `http://127.0.0.1:8420/mcp/<profile>` instead of spawning anything.

```
  github ──┐
  linear ──┼──► MCP Gateway ──► Claude Code · Claude Desktop · Cursor
  fs ──────┤     127.0.0.1:8420
  slack ───┘     policy · limits · audit
```

## Why

- **One config, not four.** Add a server once. Every client sees it.
- **One process per backend.** Three clients connected still means one GitHub subprocess.
- **Fewer, better tools.** Expose 12 relevant tools instead of 120, renamed to whatever reads
  clearly to the model.
- **Nothing runs unlogged.** Every call — allowed, denied, or failed — is one line of JSON.
- **Real brakes.** A denied tool is invisible *and* uncallable. Rate limits are per profile, and per server.
- **Tools can't change under you.** Descriptions are hashed and pinned; a server that quietly
  rewrites one gets blocked until you review the diff.

## Requirements

Node 22.13 or newer. Nothing else — no database, no Redis, no external services. Three runtime
dependencies: the MCP SDK, `yaml`, and `zod`.

## Install

Not published to npm. Build it from the repository:

```bash
npm install && npm run build
```

That produces `dist/src/cli.js` (`mcpgw`) and `dist/src/bridge.js` (`mcpgw-bridge`). Link them
onto your `PATH` with `npm link` if you want the bare command names.

## Configure

Create `config.yaml`. Declare your servers once, then compose profiles from them:

```yaml
version: 1

listen:
  host: 127.0.0.1
  port: 8420

servers:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}

  fs:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "~/code"]

  linear:
    transport: http
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: Bearer ${LINEAR_KEY}

profiles:
  default:
    servers: ["*"]

  readonly:
    servers: [github, linear]
    allow: ["github__get_*", "github__list_*", "linear__list_*"]

  coding:
    servers: [github, fs]
    deny: ["github__delete_*", "github__merge_pull_request"]
    rename:
      github__create_issue: file_bug
    limits: { rpm: 60, concurrent: 4 }
```

Credentials come from environment variables via `${VAR}` — they never live in the config file.

A backend can also carry its own limits, so one busy server cannot starve the rest, and can cache
the tools you know are safe to repeat:

```yaml
servers:
  fs:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/vedant/code"]
    limits: { concurrent: 2 }           # on top of each profile's own
    cache:
      tools: ["read_*", "list_*"]       # opt-in: the gateway cannot know what is idempotent
      ttl_ms: 30000
```

Then start it:

```bash
mcpgw start
```

## Connect your clients

Give each client the profile that fits it — `coding` for your editor, `readonly` for anything
you trust less. Every entry below *replaces* that client's direct server entries; nothing but
the gateway should be spawning backends any more.

**Claude Code** (`~/.claude.json`) speaks HTTP, so it points straight at a profile:

```json
{ "mcpServers": { "gateway": { "type": "http", "url": "http://127.0.0.1:8420/mcp/coding" } } }
```

**Claude Desktop** (`%APPDATA%/Claude/claude_desktop_config.json`, or
`~/Library/Application Support/Claude/` on macOS) speaks only stdio, so it launches the bridge —
a shim that pipes stdin/stdout to the daemon and spawns no backends of its own:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "node",
      "args": ["/abs/path/to/mcp-gateway/dist/src/bridge.js",
               "--url", "http://127.0.0.1:8420/mcp/readonly"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) uses the same bridge, usually on a different profile:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "node",
      "args": ["/abs/path/to/mcp-gateway/dist/src/bridge.js",
               "--url", "http://127.0.0.1:8420/mcp/coding"]
    }
  }
}
```

If the daemon is not running, the bridge exits immediately with a readable message instead of
hanging on the first tool call.

## CLI

| Command | What it does |
|---------|--------------|
| `mcpgw start` | Run the daemon |
| `mcpgw validate` | Check the config without starting; exits non-zero on any error |
| `mcpgw status` | Backend health, uptime, restart counts, active sessions, pending drift |
| `mcpgw list --profile coding` | Every tool the profile exposes, plus the rule behind each decision |
| `mcpgw pin` | Show changed tool descriptions as diffs; `--yes` accepts them |
| `mcpgw auth <server>` | Authorize an `auth: oauth` backend in a browser, once |
| `mcpgw reload` | Re-read the config in the running daemon (what SIGHUP does) |
| `mcpgw restart <server>` | Reconnect one backend without touching the others or the daemon |
| `mcpgw tail --denied-only` | Stream the audit log |
| `mcpgw query "<SQL>"` | SQL over the audit log, for what one line of `jq` cannot answer |

`mcpgw list` is the one to reach for when a tool isn't showing up — it prints the decision and
the exact rule that produced it.

`mcpgw restart` is what you want when a backend has given up: it exhausted its retries, or it
was DOWN waiting for `mcpgw auth`. `reload` cannot help there, because it deliberately skips any
server whose definition has not changed — which is exactly those two cases.

`SIGHUP` reloads the config, restarting only the servers whose definitions actually changed —
live sessions keep working, and a new allow list applies to them without a reconnect. A bad edit
is rejected and the previous config keeps serving. `SIGTERM`/`SIGINT` stop accepting new work,
give in-flight calls up to 5 seconds to finish, then shut the backends down.

## Remote servers that need OAuth

A remote MCP server that answers `401` with a `WWW-Authenticate` header wants an OAuth token,
not a static header. Mark it and authorize it once:

```yaml
servers:
  figma:
    transport: http
    url: https://mcp.figma.com/mcp
    auth: oauth
    scope: "mcp:connect"
```

```bash
mcpgw auth figma
```

That opens a browser, completes the authorization-code flow with PKCE, and writes the tokens to
`tools.lock.json`'s neighbour `tokens.json` (mode 0600, gitignored). Then `mcpgw restart figma`
brings it up — the daemon notices the new tokens on disk. From then on it connects on its own
and refreshes the access token silently; you only run `mcpgw auth` again if the refresh token is
revoked.

The daemon never opens a browser by itself. A backend that needs authorizing stays DOWN with
`needs authorization: run mcpgw auth <server>` and does **not** retry — retrying an expired
authorization only burns backoff until a human acts.

**Servers that refuse dynamic registration.** Many commercial servers advertise a registration
endpoint and then reject it, because they expect an OAuth app you created by hand. Figma is one.
Create the app with redirect URI `http://127.0.0.1:8419/callback` (or another port, set as
`listen.oauth_callback_port`, if 8419 is taken), then:

```yaml
servers:
  figma:
    transport: http
    url: https://mcp.figma.com/mcp
    auth: oauth
    scope: "mcp:connect"
    client_id: ${FIGMA_CLIENT_ID}
    client_secret: ${FIGMA_CLIENT_SECRET}
```

The credentials come from the environment like every other secret. With `client_id` set, no
registration is attempted at all.

**Machine-to-machine servers.** A server that issues tokens to a client ID and secret, with no
user in the loop, needs no browser at all:

```yaml
servers:
  internal:
    transport: http
    url: https://mcp.internal.example/mcp
    auth: oauth
    oauth_grant: client_credentials
    client_id: ${INTERNAL_CLIENT_ID}
    client_secret: ${INTERNAL_CLIENT_SECRET}
```

The daemon fetches its own token and fetches another when it expires. A wrong secret leaves the
backend DOWN with `authorization failed, check client_id and client_secret`, not retrying.

## Policy

A profile picks servers, then filters their tools with globs. **Deny always beats allow**, and
if an `allow` list is present, anything not matching it is excluded. Filtering applies to both
listing and calling — a tool the model never saw is still refused if it guesses the name.

Tools are namespaced `<server>__<tool>` so two servers can both have a `search` without
colliding. Globs always match the canonical name, never the alias, so renaming can never be
used to slip past a deny rule.

Some tools you want reachable, but not unattended. List them under `approve`, and each call
waits for you to say yes in the client that made it:

```yaml
profiles:
  coding:
    servers: [github, fs]
    approve: ["github__create_pull_request", "fs__write_file"]
```

The gateway asks through MCP elicitation, showing the tool and its (redacted) arguments. A
decline, a dismissal, or no answer within `guard.approval_timeout_ms` refuses the call. So does
a client that cannot elicit at all — an approval that cannot be asked for is never assumed.

## Resources and prompts

Both are proxied alongside tools, namespaced the same way. Prompts become `<server>__<name>`;
resources get a scheme, `mcpgw://<server>/<original-uri>`, so the backend's own URI survives
whole and comes back intact on the way down.

`resources/subscribe` is reference-counted: however many sessions watch the same resource, the
backend is subscribed once, and `notifications/resources/updated` is delivered only to the
sessions that asked — closing a session releases whatever it was the last one holding.

The two are filtered differently, and the difference is deliberate:

| | Filtered by |
|---|---|
| Tools, prompts | The full policy: server membership, then deny globs, then the allow list |
| Resources, templates | Server membership only |

Globs are written against names, and a resource is addressed by URI — matching `github__get_*`
against `mcpgw://github/file:///x` would be guesswork. So a profile that can reach a server can
read its resources. If that is too broad for a server you are exposing, keep it out of that
profile's `servers` list rather than trying to express it as a glob.

## Cancellation and logging

A client that cancels a call cancels it all the way down: the abort is carried into the backend
request, so the backend stops working rather than finishing into a discarded result. Other
sessions sharing that backend are unaffected.

`logging/setLevel` is recorded per session and never pushed down to the backends — they are
shared, so one client asking for `debug` would turn it on for everyone. A backend's log messages
are routed to the session whose call they arrived during and filtered by that session's own
level (default `info`). A message that arrives with no call in flight is dropped rather than
broadcast, for the same reason a reverse request in that state gets `-32006`.

## Audit log

One JSON object per line, in `audit/YYYY-MM-DD.jsonl`:

```json
{"ts":"2026-08-31T10:12:44.812Z","session":"s_7f3a91","profile":"coding",
 "client":{"name":"claude-code","version":"2.1.0"},"method":"tools/call",
 "server":"github","tool":"create_issue","exposed_as":"file_bug",
 "decision":"allow","args_hash":"sha256:7ab1…","dur_ms":412,"status":"ok"}
```

Plain JSONL, so `jq` is the query engine:

```bash
jq 'select(.decision != "allow")' audit/*.jsonl
```

Arguments are hashed by default. Set `log_args: full` to record them, or `none` to record
nothing — either way, configured regex patterns are redacted before anything is written.

When a question outgrows one line of `jq`, ask it in SQL:

```bash
mcpgw query "select tool, count(*) as refused from audit where decision != 'allow' group by tool"
mcpgw query "select server, count(*) as calls, max(dur_ms) as slowest from audit
             where method = 'tools/call' and ts >= date('now', '-7 days') group by server"
mcpgw query "select json_extract(line, '$.error.message') as error, count(*) from audit
             where status = 'error' group by error" --json
```

It keeps an index, `audit/index.sqlite`, built with Node's own SQLite and caught up from the JSONL
on every query. The JSONL stays the record: delete the index and the next query rebuilds it. The
table is `audit`, with the common fields as columns and the whole original line in `line`.
Queries run on a read-only connection.

## Status page

`http://127.0.0.1:8420/dashboard` shows the backends, pending pinning changes, and the most recent
refusals and errors, refreshing every five seconds. It is read-only — nothing behind it changes
anything — and it shows only what `/healthz` and the audit log already show. With `listen.token`
set, it asks for the token and keeps it for that browser tab only.

## Tool pinning

The first time a tool or prompt is seen, a hash of what it tells the model — name, description,
and its schema or arguments — goes into `tools.lock.json`. Every startup and every
`list_changed` re-checks it. If a server rewrites one after you approved it, it is blocked, the
change is logged, and a diff is printed. `mcpgw pin` is the only way to accept it, and
`mcpgw pin --yes` tells a running daemon to reload, so the accepted tool comes back without a
restart.

A hash only notices change. So every description is also scanned for what injected instructions
tend to look like — "ignore previous instructions", "do not tell the user", `<IMPORTANT>` tags,
invisible characters, credential paths — including on first sight. By default a hit is flagged
in the listing (`on_suspicious: warn`); `block` refuses it until `mcpgw pin` shows you the
findings and you accept them. It is a heuristic: it catches the careless attack, not the
careful one.

Commit `tools.lock.json`.

## Known limits

Deliberate, and each one is marked in the code:

- **Reverse requests need one session per backend at a time.** A backend asking the client to
  sample is routed to the session with work outstanding on it, however many calls that session
  has running. With calls from two different sessions in flight on one backend it gets `-32006`
  rather than a guess — guessing would leak one client's prompt to another.
- **Process trees are not cleaned up after a crash.** When the gateway stops or restarts a
  backend it kills whatever that backend's launcher left running, but a launcher that crashed on
  its own may leave its children behind.
- **Rate limits survive only a graceful restart.** A crash resets the buckets.
- **Audit writes are best-effort by default.** A hard crash can lose the last few lines;
  `audit.durable: true` fsyncs every line, at the cost of a synchronous write per request.
- **Listings are one page by default.** Set `listen.page_size` for a profile with a very large
  catalog; many clients never follow a cursor, which is why it is not the default.
- **SSE resumption is in memory.** A client that drops its stream can resume with
  `Last-Event-ID` from the last 256 events (4 MiB) of its session; after a daemon restart, or a
  longer gap, it re-initializes.
- **Approvals hold their slot.** A call waiting on a human keeps its rate-limit slots for up to
  `approval_timeout_ms`.
- **No device-code OAuth.** Authorization code (with a browser, once) and client credentials are
  supported; the device flow is not.
- **One process.** To use more cores, or to keep two sets of credentials apart, run several
  daemons — see below.

## Security

There is no client authentication, by design. The trust boundary is the local machine.

That only holds if the daemon stays local, so the gateway **refuses to bind a non-loopback
address** unless you explicitly set `listen.token`. Reaching the port means inheriting every
credential the gateway holds — the interlock is enforced at startup, not left to convention.

Two smaller rules follow from the same reasoning. The `Origin` check runs before everything
else, and without a token the `Host` header must be loopback too, so no route — not even
`/healthz` — answers a browser tab or a DNS-rebound page. And `/healthz` returns bare liveness to
an unauthorized caller: backend names, pids and error strings are detail, and detail needs the
token. The bridge only ever needed the liveness half.

**Reaching it from another machine.** Set a token, a non-loopback host, and TLS, so the token is
not sent across the network in the clear:

```yaml
listen:
  host: 0.0.0.0
  token: ${MCPGW_TOKEN}
  tls: { cert: ~/certs/gateway.pem, key: ~/certs/gateway-key.pem }
```

Without `tls` the daemon still starts, and logs `insecure_lan` to say so. Every refused token is
written to the audit log with the address it came from. A client that must trust a self-signed
certificate — the bridge, or `mcpgw status` — can be pointed at it with `NODE_EXTRA_CA_CERTS`.

## Running several daemons

One daemon is one process. To spread load, or to keep one set of credentials away from another,
give each daemon its own directory: its own `config.yaml` with its own `listen.port`, and with it
its own `tools.lock.json`, `tokens.json`, rate-limit state and `audit/`, all of which live beside
the config. Point each client at the port of the daemon it belongs to.

```bash
mcpgw start --config ~/gateways/work/config.yaml       # listen.port: 8420
mcpgw start --config ~/gateways/personal/config.yaml   # listen.port: 8430
```

## Logo

Lines fan in from the left and converge to a single point inside a rounded gate, leaving as one
line on the right. Many backends in, one governed path out — and the gate is the only way
through.

<img src="assets/icon.png" width="72" align="right" alt="MCP Gateway icon">

| File | Use |
|------|-----|
| [`assets/logo.png`](assets/logo.png) | Horizontal lockup, mark plus wordmark. README and documentation headers |
| [`assets/icon.png`](assets/icon.png) | Square mark on its own. Favicon, app icon, social card |

Both are transparent PNGs in slate `#34494D`, which holds up on light and dark backgrounds
alike.

## License

MIT
