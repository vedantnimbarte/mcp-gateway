// The status page (PRD §3 as amended): backends, drift, and recent refusals. Both files are static
// and carry no data. The page fetches /healthz and /audit/recent like any client, with the token
// when one is set, so it can show nothing a curl with the same token could not. Its buttons call
// the same token-gated routes as the CLI, and appear only when /healthz reports `manage`.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-gateway</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2528; --muted: #5f6b70; --line: #d9dfe1; --bad: #b3261e; --ok: #2e6b3a; --bg: #fbfbfa; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e3e8e9; --muted: #9aa5a9; --line: #333c3f; --bad: #f2b8b5; --ok: #9bd3a4; --bg: #151a1c; } }
  [hidden] { display: none !important; } /* else the flex rules below would override it */
  body { margin: 0; padding: 24px 16px; font: 14px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 28px 0 8px; }
  .muted { color: var(--muted); } .bad { color: var(--bad); } .ok { color: var(--ok); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); }
  form { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  input, button { font: inherit; padding: 6px 8px; min-width: 0; }
  td button { padding: 2px 8px; }
  #controls { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  #message { margin-top: 8px; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>mcp-gateway</h1>
  <div id="summary" class="muted">loading…</div>
  <form id="login" hidden>
    <input id="token" type="password" placeholder="listen.token" autocomplete="off" aria-label="Gateway token">
    <button>Show detail</button>
  </form>
  <div id="controls" hidden>
    <button id="reload" type="button">Reload config</button>
    <button id="stop" type="button">Stop gateway</button>
  </div>
  <div id="message" role="status"></div>
  <h2>Backends</h2>
  <div class="scroll"><table><thead><tr><th>Server</th><th>State</th><th>Tools</th><th>Restarts</th><th>PID</th><th>Error</th><th></th></tr></thead><tbody id="backends"></tbody></table></div>
  <h2>Recent refusals and errors</h2>
  <div class="scroll"><table><thead><tr><th>Time</th><th>Profile</th><th>Decision</th><th>Tool</th><th>Error</th></tr></thead><tbody id="audit"></tbody></table></div>
</main>
<script src="/dashboard.js"></script>
</body>
</html>
`;

export const DASHBOARD_JS = `"use strict";
const $ = (id) => document.getElementById(id);
const store = { get: () => { try { return sessionStorage.getItem("mcpgw-token") || ""; } catch { return ""; } },
                set: (t) => { try { sessionStorage.setItem("mcpgw-token", t); } catch {} } };

function cell(row, text, cls) {
  const td = document.createElement("td");
  td.textContent = text == null ? "" : String(text);
  if (cls) td.className = cls;
  row.appendChild(td);
}

async function get(path) {
  const token = store.get();
  const res = await fetch(path, { headers: token ? { authorization: "Bearer " + token } : {} });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function post(path) {
  const token = store.get();
  const res = await fetch(path, { method: "POST", headers: token ? { authorization: "Bearer " + token } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function say(text, bad) {
  $("message").textContent = text;
  $("message").className = bad ? "bad" : "muted";
}

/** Disables the button while its request runs, so a second click cannot stack another. */
async function act(button, path, done) {
  button.disabled = true;
  try {
    const r = await post(path);
    done(r);
  } catch {
    say("the gateway did not answer", true);
  } finally {
    button.disabled = false;
    refresh().catch(() => {});
  }
}

async function refresh() {
  const health = await get("/healthz");
  const detail = health.body && health.body.backends;
  $("login").hidden = Boolean(detail);
  $("controls").hidden = !(detail && health.body.manage);
  if (!detail) {
    $("summary").textContent = health.body ? "up — enter the token to see detail" : "not answering";
    return;
  }
  const h = health.body;
  $("summary").textContent = "up " + Math.floor(h.uptime_s / 60) + " min · " + h.sessions +
    " session(s) · " + h.pending_drift + " pending change(s) for mcpgw pin";

  const backends = $("backends");
  backends.replaceChildren();
  for (const [name, b] of Object.entries(h.backends)) {
    const row = backends.insertRow();
    cell(row, name);
    cell(row, b.state, b.state === "up" ? "ok" : "bad");
    cell(row, b.tools); cell(row, b.restarts); cell(row, b.pid); cell(row, b.error, "bad");
    const actions = row.insertCell();
    if (h.manage) {
      const restart = document.createElement("button");
      restart.type = "button";
      restart.textContent = "Restart";
      restart.addEventListener("click", () => act(restart, "/restart/" + encodeURIComponent(name), (r) =>
        r.status === 200
          ? say(name + " restarted: " + r.body.status + (r.body.error ? " — " + r.body.error : ""), r.body.status !== "up")
          : say("restart failed: " + ((r.body && r.body.error) || r.status), true)));
      actions.appendChild(restart);
    }
  }

  const recent = await get("/audit/recent?n=100&denied=1");
  const audit = $("audit");
  audit.replaceChildren();
  for (const line of (recent.body && recent.body.lines) || []) {
    const row = audit.insertRow();
    cell(row, (line.ts || "").replace("T", " ").slice(0, 19));
    cell(row, line.profile);
    cell(row, line.decision || line.status, "bad");
    cell(row, line.exposed_as || (line.server ? line.server + "__" + (line.tool || "") : line.method));
    cell(row, line.error && line.error.message);
  }
}

$("login").addEventListener("submit", (e) => { e.preventDefault(); store.set($("token").value); refresh(); });
$("reload").addEventListener("click", () => act($("reload"), "/reload", (r) =>
  r.status === 200
    ? say("config reloaded")
    : say("config unchanged:\\n" + ((r.body && (r.body.problems || [r.body.error]).join("\\n")) || r.status), true)));
$("stop").addEventListener("click", () => {
  if (!confirm("Stop the gateway? Every client loses its connection, and nothing on this page can start it again.")) return;
  act($("stop"), "/stop", (r) =>
    r.status === 202
      ? say("stopping — run mcpgw start to bring it back")
      : say("stop failed: " + ((r.body && r.body.error) || r.status), true));
});
refresh().catch(() => { $("summary").textContent = "not answering"; });
setInterval(() => refresh().catch(() => {}), 5000);
`;
