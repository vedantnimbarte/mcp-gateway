// The status page (PRD §3 as amended), served at `/`. Both files are static and carry no data.
// The page fetches /healthz, /audit/stats, /audit/recent and /profiles/<p>/tools like any client,
// with the token when one is set, so it can show nothing a curl with the same token could not. Its
// buttons call the same token-gated routes as the CLI, and appear only when /healthz reports
// `manage`.
//
// Design: a signal box. The track diagram on the overview is the gateway's own logo made live:
// backend lines converge on the gate and leave as profiles, each lit by its state. The views are
// tabs whose active route is marked the way the diagram marks a set route, with a heavy slate
// rule. Under it is the logbook: plain tables on paper. One family, Bahnschrift (DIN, the signage
// face), with its semi-condensed cut for figures.
//
// Each view lives at its own hash (#/tools) and fetches only what it shows. String.raw keeps the
// client code free of escaping; it must contain no backticks and no dollar-brace.

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-gateway</title>
<style>
  :root {
    color-scheme: light dark;
    --ground: #dce3de; --sheet: #f5f7f5; --ink: #22343a; --muted: #5b6d71; --faint: #8a9b9c;
    --rule: #c3cdc8; --rule-soft: #e2e8e4; --slate: #34494d; --on-slate: #eef3f1;
    --track: #8fa29f; --go: #1f8a4c; --caution: #c98200; --stop: #c23b22; --off: #a2afad;
    --bar: #34494d;
    --font: Bahnschrift, "D-DIN", "DIN Alternate", "DIN Next", Barlow, "Segoe UI", system-ui, sans-serif;
    --data: "Bahnschrift SemiCondensed", "D-DIN Condensed", "DIN Condensed", "Barlow Semi Condensed", Bahnschrift, "Segoe UI", system-ui, sans-serif;
    --gutter: clamp(16px, 4vw, 40px);
  }
  /* The theme: Auto follows the system; Light and Dark set data-theme on the root and win over it. */
  :root[data-theme="light"] { color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --ground: #142125; --sheet: #1b2a2f; --ink: #e1eae7; --muted: #92a5a7; --faint: #6c8084;
      --rule: #32464b; --rule-soft: #24363b; --slate: #b4cacc; --on-slate: #142125;
      --track: #4d676c; --go: #43c07c; --caution: #e6a72b; --stop: #f06b52; --off: #4f6266;
      --bar: #8fb1b5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --ground: #142125; --sheet: #1b2a2f; --ink: #e1eae7; --muted: #92a5a7; --faint: #6c8084;
    --rule: #32464b; --rule-soft: #24363b; --slate: #b4cacc; --on-slate: #142125;
    --track: #4d676c; --go: #43c07c; --caution: #e6a72b; --stop: #f06b52; --off: #4f6266;
    --bar: #8fb1b5;
  }
  [hidden] { display: none !important; } /* else the flex rules below would override it */
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 var(--font); color: var(--ink); background: var(--ground); min-height: 100vh; display: flex; flex-direction: column; }
  button, input, select, textarea { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--slate); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .wrap { max-width: 1240px; margin: 0 auto; padding-left: var(--gutter); padding-right: var(--gutter); width: 100%; }

  /* The bar: who this is and whether it is running. */
  .bar { padding-top: 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand svg { width: 30px; height: 22px; color: var(--slate); }
  h1 { font-size: 19px; font-weight: 600; letter-spacing: 0.01em; margin: 0; }
  #summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; margin: 0; color: var(--muted); }
  #summary strong { color: var(--ink); font-weight: 600; }
  .push { margin-left: auto; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  #controls { display: flex; gap: 8px; }

  /* The routes. The current one is marked like a set route on the diagram. */
  .nav { display: flex; gap: 0 28px; padding-top: 14px; overflow-x: auto; scrollbar-width: none; }
  .nav::-webkit-scrollbar { display: none; }
  .nav a { position: relative; display: inline-flex; align-items: center; gap: 8px; padding: 8px 0 13px;
           color: var(--muted); text-decoration: none; font-size: 15.5px; font-weight: 600; white-space: nowrap; }
  .nav a:hover { color: var(--ink); }
  .nav a[aria-current="page"] { color: var(--ink); }
  .nav a[aria-current="page"]::after { content: ""; position: absolute; left: -2px; right: -2px; bottom: 0; height: 5px;
           border-radius: 3px 3px 0 0; background: var(--slate); }
  .count { font-family: var(--data); font-size: 12.5px; font-weight: 600; line-height: 19px; padding: 0 7px; border-radius: 10px;
           background: var(--rule); color: var(--ink); }
  .count.bad { background: var(--stop); color: #fff; }
  .count.warn { background: var(--caution); color: #1b1300; }

  button { border: 1px solid var(--rule); background: var(--sheet); border-radius: 6px; padding: 6px 12px;
           font-size: 13.5px; cursor: pointer; }
  button:hover { border-color: var(--slate); }
  button:disabled { opacity: 0.55; cursor: progress; }
  button.danger { color: var(--stop); }
  .seg { display: inline-flex; border: 1px solid var(--rule); border-radius: 8px; padding: 2px; background: var(--sheet); }
  .seg button { border: 0; border-radius: 6px; padding: 4px 11px; background: transparent; font-family: var(--data); }
  .seg button[aria-pressed="true"] { background: var(--slate); color: var(--on-slate); }
  input[type="search"], input[type="password"], select { padding: 6px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--sheet); min-width: 0; }

  .lamp { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--off); flex: none; }
  .lamp.up { background: var(--go); box-shadow: 0 0 0 3px color-mix(in srgb, var(--go) 22%, transparent); }
  .lamp.connecting { background: var(--caution); box-shadow: 0 0 0 3px color-mix(in srgb, var(--caution) 22%, transparent); }
  .lamp.down { background: var(--stop); box-shadow: 0 0 0 3px color-mix(in srgb, var(--stop) 22%, transparent); }

  .gate-form { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 18px; }
  .gate-form input { width: 22em; max-width: 100%; }
  #message { white-space: pre-wrap; color: var(--muted); }
  #message:not(:empty) { padding-top: 10px; }
  #message.bad { color: var(--stop); }

  /* The mimic panel: the diagram sits on the ground, not on a card. */
  .map { padding-top: 14px; padding-bottom: 18px; }
  .map-scroll { overflow-x: auto; }
  #map { display: block; width: 100%; min-width: 700px; height: auto; }
  #map text { font-family: var(--font); }
  .m-name { font-size: 19px; font-weight: 600; fill: var(--ink); }
  .m-sub { font-size: 15px; fill: var(--muted); font-family: var(--data) !important; }
  .m-gate { fill: var(--slate); }
  .m-gate-text { fill: var(--on-slate); font-size: 19px; font-weight: 600; }
  .m-gate-sub { fill: var(--on-slate); font-size: 14.5px; opacity: 0.8; font-family: var(--data) !important; }
  .m-lamp { fill: var(--off); }
  .m-lamp.up { fill: var(--go); } .m-lamp.connecting { fill: var(--caution); } .m-lamp.down { fill: var(--stop); }
  .m-halo { fill: none; stroke-width: 6; opacity: 0.2; stroke: var(--off); }
  .m-halo.up { stroke: var(--go); } .m-halo.connecting { stroke: var(--caution); } .m-halo.down { stroke: var(--stop); }
  .track { fill: none; stroke: var(--track); stroke-linecap: round; }
  .track.down { stroke: var(--stop); opacity: 0.75; }
  .track.connecting { stroke: var(--caution); }
  .track.disabled { stroke: var(--off); stroke-dasharray: 2 7; }
  .train { fill: none; stroke: var(--go); stroke-linecap: round; stroke-dasharray: 10 24; animation: run 1.4s linear infinite; }
  @keyframes run { to { stroke-dashoffset: -34; } }
  @media (prefers-reduced-motion: reduce) { .train { animation: none; stroke-dasharray: none; opacity: 0.6; } }
  .m-empty { font-size: 16px; fill: var(--muted); }

  /* The logbook: one sheet of paper, sections ruled off. */
  #detail { flex: 1; display: flex; flex-direction: column; }
  .sheet { flex: 1; background: var(--sheet); box-shadow: 0 -1px 0 var(--rule); }
  .sheet > .wrap { padding-top: 6px; padding-bottom: 48px; }
  .view-overview .sheet { border-radius: 16px 16px 0 0; }
  section.log { padding: 26px 0 8px; border-top: 1px solid var(--rule-soft); }
  section.log:first-child { border-top: 0; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  h2 .seg, h2 select { font-size: 13px; font-weight: 400; }
  .tools-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 0 0 14px; }
  .tools-bar input[type="search"] { width: 18em; max-width: 100%; }
  .note { color: var(--muted); margin: -4px 0 12px; max-width: 72ch; }
  .tally-line { color: var(--muted); font-family: var(--data); }
  code { font-family: var(--data); background: var(--rule-soft); padding: 0 4px; border-radius: 4px; }

  .ledger { display: flex; flex-wrap: wrap; gap: 14px 38px; margin: 0 0 18px; }
  .ledger div { display: flex; flex-direction: column; }
  .ledger dd { margin: 0; font-family: var(--data); font-size: 28px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .ledger dt { order: 2; color: var(--muted); font-size: 13px; }
  .ledger dd.warn { color: var(--caution); } .ledger dd.bad { color: var(--stop); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); font-size: 13px; margin: 0 0 6px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .chart svg { display: block; width: 100%; height: auto; }
  .chart text { font-family: var(--data); font-size: 15px; fill: var(--muted); }
  .grid { stroke: var(--rule-soft); }
  .b-ok { fill: var(--bar); } .b-refused { fill: var(--caution); } .b-error { fill: var(--stop); }
  .s-ok { background: var(--bar); } .s-refused { background: var(--caution); } .s-error { background: var(--stop); }

  .split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 0 48px; }
  @media (max-width: 860px) { .split { grid-template-columns: minmax(0, 1fr); } }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-family: var(--data); font-variant-numeric: tabular-nums; font-size: 14px; }
  th, td { text-align: left; padding: 7px 16px 7px 0; border-bottom: 1px solid var(--rule-soft); white-space: nowrap; vertical-align: middle; }
  th { font-weight: 600; color: var(--muted); font-size: 12.5px; border-bottom-color: var(--rule); }
  td.num, th.num { text-align: right; }
  td.wrap { white-space: normal; min-width: 9em; }
  td button { padding: 2px 9px; font-size: 12.5px; }
  td button + button { margin-left: 4px; }
  .name { display: inline-flex; align-items: center; gap: 9px; font-family: var(--font); font-weight: 600; }
  .alias { color: var(--muted); font-weight: 400; }
  .muted { color: var(--muted); } .faint { color: var(--faint); }
  .ok { color: var(--go); } .bad { color: var(--stop); } .warn { color: var(--caution); }
  .meter { display: flex; align-items: center; gap: 10px; }
  .meter i { display: block; height: 6px; border-radius: 3px; background: var(--bar); min-width: 2px; }
  .empty { color: var(--muted); padding: 10px 0; margin: 0; white-space: normal; }
  a.more { color: var(--slate); font-weight: 600; }

  .tally { list-style: none; margin: 0 0 22px; padding: 0; font-family: var(--data); }
  .tally li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 6px 0; border-bottom: 1px solid var(--rule-soft); }
  .tally li i { grid-column: 1 / -1; display: block; height: 4px; border-radius: 2px; background: var(--caution); }
  .tally.plain li i { background: var(--bar); }

  .attention { list-style: none; margin: 0 0 8px; padding: 0; }
  .attention li { display: flex; gap: 12px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--rule-soft); }
  .attention li .lamp { transform: translateY(-1px); }

  /* Tools, grouped by server: one group per backend, folded with the native disclosure. */
  details.group { border-top: 1px solid var(--rule); }
  details.group:last-of-type { border-bottom: 1px solid var(--rule); }
  details.group summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 11px 0; cursor: pointer; list-style: none; }
  details.group summary::-webkit-details-marker { display: none; }
  details.group summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
           transform: rotate(-45deg); transition: transform 0.15s ease; margin-right: 2px; }
  details.group[open] summary::before { transform: rotate(45deg); }
  @media (prefers-reduced-motion: reduce) { details.group summary::before { transition: none; } }
  details.group summary .name { font-size: 15.5px; }
  /* One fixed grid for every group, so columns line up from one server to the next. */
  details.group table { margin-bottom: 10px; table-layout: fixed; min-width: 640px; }
  details.group td { overflow: hidden; text-overflow: ellipsis; }
  .c-tool { width: 30%; } .c-decision { width: 21%; } .c-rule { width: 21%; } .c-num { width: 9%; } .c-act { width: 10%; }

  textarea { width: 100%; min-height: 26em; white-space: pre; overflow-x: auto; font: 13px/1.45 ui-monospace, Consolas, monospace; padding: 10px 12px; tab-size: 2;
             border: 1px solid var(--rule); border-radius: 8px; background: var(--ground); }
  .row { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 24px; margin: 0; font-family: var(--data); }
  .facts dt { color: var(--muted); } .facts dd { margin: 0; overflow-wrap: anywhere; }
</style>
<!-- In the head, not deferred: it sets the saved theme before the first paint, then waits for the page. -->
<script src="/dashboard.js"></script>
</head>
<body>
<header>
  <div class="wrap bar">
    <div class="brand">
      <svg viewBox="0 0 30 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M1 3 C 8 3, 9 11, 14 11 M1 11 H14 M1 19 C 8 19, 9 11, 14 11 M22 11 H29"/>
        <rect x="12" y="6" width="11" height="10" rx="5"/>
      </svg>
      <h1>mcp-gateway</h1>
    </div>
    <p id="summary"><span class="lamp"></span><span>Connecting…</span></p>
    <div class="push">
      <div class="seg" id="window" role="group" aria-label="Time window" hidden>
        <button type="button" data-window="1h">1h</button><button type="button" data-window="24h">24h</button><button type="button" data-window="7d">7d</button>
      </div>
      <div id="controls" hidden>
        <button id="reload" type="button">Reload config</button>
        <button id="stop" type="button" class="danger">Stop gateway</button>
      </div>
      <div class="seg" id="theme" role="group" aria-label="Theme">
        <button type="button" data-theme-choice="auto" title="Follow the system setting">Auto</button><button type="button" data-theme-choice="light">Light</button><button type="button" data-theme-choice="dark">Dark</button>
      </div>
    </div>
  </div>
  <form id="login" class="wrap gate-form" hidden>
    <input id="token" type="password" placeholder="listen.token" autocomplete="off" aria-label="Gateway token">
    <button>Show detail</button>
  </form>
  <div id="message" class="wrap" role="status"></div>
  <nav class="wrap nav" id="nav" aria-label="Views" hidden>
    <a href="#/overview" data-view="overview">Overview</a>
    <a href="#/traffic" data-view="traffic">Traffic</a>
    <a href="#/backends" data-view="backends">Backends <span class="count" id="count-backends"></span></a>
    <a href="#/tools" data-view="tools">Tools <span class="count" id="count-tools"></span></a>
    <a href="#/activity" data-view="activity">Activity <span class="count" id="count-activity" hidden></span></a>
    <a href="#/config" data-view="config">Config</a>
  </nav>
</header>

<div id="detail" hidden>
  <section class="wrap map" data-for="overview" aria-labelledby="map-title">
    <h2 id="map-title" class="sr-only">Backends, gateway and profiles</h2>
    <div class="map-scroll"><svg id="map" role="img" aria-labelledby="map-title"></svg></div>
  </section>

  <main class="sheet"><div class="wrap">

    <div data-for="overview">
      <section class="log">
        <h2>Needs attention</h2>
        <ul class="attention" id="attention"></ul>
      </section>
      <section class="log">
        <h2 id="overview-title">Traffic</h2>
        <dl class="ledger" id="overview-ledger"></dl>
        <div class="chart" id="overview-chart"></div>
        <p><a class="more" href="#/traffic">See tools, clients and refusals</a></p>
      </section>
    </div>

    <div data-for="traffic">
      <section class="log">
        <h2>Traffic</h2>
        <dl class="ledger" id="ledger"></dl>
        <p class="legend"><span><i class="swatch s-ok"></i>Succeeded</span><span><i class="swatch s-refused"></i>Refused</span><span><i class="swatch s-error"></i>Failed</span><span id="partial" hidden>Busy window: counted from its most recent 32 MB of log</span></p>
        <div class="chart" id="chart"></div>
      </section>
      <div class="split">
        <section class="log">
          <h2>Busiest tools</h2>
          <div class="scroll"><table><thead><tr><th>Tool</th><th>Calls</th><th class="num">Failed</th><th class="num">Refused</th><th class="num">p95</th></tr></thead><tbody id="top-tools"></tbody></table></div>
          <p><a class="more" href="#/tools">See every tool</a></p>
        </section>
        <section class="log">
          <h2>Why calls were refused</h2>
          <ul class="tally" id="reasons"></ul>
          <h2>Clients</h2>
          <ul class="tally plain" id="clients"></ul>
        </section>
      </div>
      <section class="log">
        <h2>Profiles</h2>
        <div class="scroll"><table><thead><tr><th>Profile</th><th class="num">Tools</th><th class="num">Clients</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Refused</th><th class="num">p95</th><th>Context</th></tr></thead><tbody id="profiles"></tbody></table></div>
      </section>
    </div>

    <div data-for="backends">
      <section class="log">
        <h2>Backends</h2>
        <div class="scroll"><table><thead><tr><th>Server</th><th>State</th><th>Transport</th><th class="num">Tools</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">p95</th><th class="num">Restarts</th><th class="num">PID</th><th>Error</th><th></th></tr></thead><tbody id="backends"></tbody></table></div>
      </section>
    </div>

    <div data-for="tools">
      <section class="log" id="tools-section">
        <h2>Tools</h2>
        <div class="tools-bar">
          <select id="profile" aria-label="Profile"></select>
          <input id="tool-search" type="search" placeholder="Find a tool" aria-label="Find a tool" spellcheck="false" autocomplete="off">
          <span class="seg" id="tool-filter" role="group" aria-label="Show">
            <button type="button" data-show="all">All</button><button type="button" data-show="allowed">Allowed</button><button type="button" data-show="blocked">Blocked</button>
          </span>
          <span class="tally-line" id="tool-tally"></span>
        </div>
        <p class="note" id="tools-note">Disable adds the tool to this profile's <code>deny</code> list in config.yaml and reloads. Tools covered by a deny glob or missing from an allow list are changed in the YAML.</p>
        <div id="tool-groups"></div>
      </section>
    </div>

    <div data-for="activity">
      <section class="log">
        <h2>Activity</h2>
        <div class="tools-bar">
          <input id="activity-search" type="search" placeholder="Filter by tool, client or profile" aria-label="Filter activity" spellcheck="false" autocomplete="off">
          <span class="seg" id="filter" role="group" aria-label="Show">
            <button type="button" data-filter="all">Everything</button><button type="button" data-filter="denied">Refused and failed</button>
          </span>
        </div>
        <div class="scroll"><table><thead><tr><th>Time</th><th>Client</th><th>Profile</th><th>What</th><th>Outcome</th><th class="num">Took</th><th class="num">Size</th></tr></thead><tbody id="audit"></tbody></table></div>
      </section>
    </div>

    <div data-for="config">
      <section class="log" id="editor-section" hidden>
        <h2>config.yaml</h2>
        <p class="note" id="editor-path"></p>
        <textarea id="editor" spellcheck="false" wrap="off" aria-label="config.yaml"></textarea>
        <div class="row">
          <button id="editor-load" type="button">Load from disk</button>
          <button id="editor-validate" type="button">Validate</button>
          <button id="editor-save" type="button">Save &amp; reload</button>
        </div>
      </section>
      <section class="log" id="editor-off">
        <h2>config.yaml</h2>
        <p class="note">The editor opens only on the machine running the gateway, with <code>listen.token</code> set. Edit the file directly, then use Reload config.</p>
      </section>
      <section class="log">
        <h2>This gateway</h2>
        <dl class="facts" id="facts"></dl>
      </section>
    </div>

  </div></main>
</div>
</body>
</html>
`;

export const DASHBOARD_JS = String.raw`"use strict";
// Runs in the head: the saved theme goes on the root before anything is painted, so a dark choice
// on a light system never flashes light. Auto removes the attribute and the CSS follows the system.
function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
  else document.documentElement.removeAttribute("data-theme");
}
let themeChoice = "auto";
try { themeChoice = localStorage.getItem("mcpgw-theme") || "auto"; } catch {}
applyTheme(themeChoice);

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

function start() {
const $ = (id) => document.getElementById(id);
const store = { get: () => { try { return sessionStorage.getItem("mcpgw-token") || ""; } catch { return ""; } },
                set: (t) => { try { sessionStorage.setItem("mcpgw-token", t); } catch {} } };
const prefs = { get: (k, d) => { try { return localStorage.getItem("mcpgw-" + k) || d; } catch { return d; } },
                set: (k, v) => { try { localStorage.setItem("mcpgw-" + k, v); } catch {} } };
const VIEWS = ["overview", "traffic", "backends", "tools", "activity", "config"];
/** Which views count calls over the window, and so show its switch. */
const WINDOWED = ["overview", "traffic", "backends", "tools"];
let windowName = prefs.get("window", "24h");
let filter = prefs.get("filter", "all");
let toolShow = prefs.get("tools-show", "all");
/** Server groups the viewer folded on the tools view; kept across refreshes. */
const folded = new Set();
/** The last answers, so typing in a search box re-renders without a fetch. */
const last = { health: null, stats: null, tools: null, recent: null };

const SVGNS = "http://www.w3.org/2000/svg";
const nf = new Intl.NumberFormat();
const num = (n) => (n == null ? "–" : nf.format(n));
const ms = (n) => (n == null ? "–" : n < 1000 ? Math.round(n) + " ms" : (n / 1000).toFixed(n < 10000 ? 2 : 1) + " s");
function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + units[i];
}
function since(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m ? m + "m" : s + "s";
}
const WINDOW_WORDS = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days" };
const REASONS = {
  denied_by_policy: "Matched a deny rule", not_allowed: "Not on the allow list",
  server_not_in_profile: "Server not in the profile", unknown_profile: "Unknown profile",
  drift_blocked: "Changed since it was pinned", suspicious_blocked: "Flagged as suspicious",
  approval_denied: "Approval declined", approval_unavailable: "Client cannot ask for approval",
  server_unavailable: "Backend was down", rate_limited: "Over the rate limit", unroutable: "Could not be routed",
  refused: "Unknown tool",
};

function view() {
  const v = location.hash.replace(/^#\/?/, "");
  return VIEWS.includes(v) ? v : "overview";
}

function cell(row, text, cls) {
  const td = document.createElement("td");
  td.textContent = text == null ? "" : String(text);
  if (cls) td.className = cls;
  row.appendChild(td);
  return td;
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function shape(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = String(text);
  return n;
}

function emptyRow(body, text, span) {
  const td = cell(body.insertRow(), text, "empty");
  td.colSpan = span;
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
  $("message").className = "wrap" + (bad ? " bad" : "");
}

/** Disables the button while its request runs, so a second click cannot stack another. */
async function act(button, path, done) {
  button.disabled = true;
  try {
    const r = await post(path);
    done(r);
  } catch {
    say("The gateway did not answer.", true);
  } finally {
    button.disabled = false;
    refresh().catch(() => {});
  }
}

function button(parent, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  parent.appendChild(b);
}

/** The answer to a config edit: saved and reloaded, or why the file was left as it was. */
function saved(what) {
  return (r) => {
    if (r.status !== 200) {
      say(what + " failed, config.yaml unchanged:\n" + problems(r), true);
      return;
    }
    // The file just changed under the editor. Untouched, it follows; edited, a save would be refused.
    const edited = editorHash !== null && $("editor").value !== editorText;
    if (editorHash !== null && !edited) loadEditor().catch(() => {});
    say(what + ": saved to config.yaml and reloaded" +
      (edited ? ". The editor has unsaved edits and no longer matches the file." : "."));
  };
}

async function sendJson(method, path, body) {
  const token = store.get();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(path, { method, headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function problems(r) {
  return (r.body && (r.body.problems || [r.body.error]).join("\n")) || String(r.status);
}

/** The hash of the text the editor last loaded; a save is refused if the file has moved on. */
let editorHash = null;
/** The text as loaded or saved, to tell whether what is on screen has been edited since. */
let editorText = "";

/** Read-only while it loads, so nothing typed meanwhile is overwritten by the answer. */
async function loadEditor() {
  $("editor").readOnly = true;
  try {
    const r = await get("/config");
    if (r.status !== 200) {
      say("Could not load config.yaml: " + r.status, true);
      return;
    }
    $("editor").value = editorText = r.body.text;
    $("editor-path").textContent = r.body.path;
    editorHash = r.body.hash;
  } finally {
    $("editor").readOnly = false;
  }
}

/** Never re-fills the text on the page's own refresh: that would throw away what is being typed. */
function refreshEditor(h) {
  $("editor-section").hidden = !h.editor;
  $("editor-off").hidden = Boolean(h.editor);
  if (h.editor && editorHash === null) loadEditor().catch(() => say("Could not load config.yaml.", true));
}

const rowFor = (rows, key) => (rows || []).find((r) => r.key === key) || { calls: 0, errors: 0, refused: 0, p95_ms: null };

function renderSummary(h) {
  const states = Object.values(h.backends).map((b) => b.state);
  const down = states.filter((s) => s === "down").length;
  const state = down ? "down" : states.includes("connecting") ? "connecting" : "up";
  const parts = [node("span", "lamp " + state), node("strong", null, "Running for " + since(h.uptime_s))];
  parts.push(node("span", null, h.sessions === 1 ? "1 client connected" : h.sessions + " clients connected"));
  if (states.length) {
    parts.push(node("span", down ? "bad" : null, down
      ? down + " of " + states.length + (states.length === 1 ? " backend" : " backends") + " down"
      : "All " + states.length + (states.length === 1 ? " backend" : " backends") + " up"));
  }
  $("summary").replaceChildren(...parts);

  const badge = (id, text, cls) => {
    const b = $(id);
    b.hidden = text === "";
    b.textContent = text;
    b.className = "count" + (cls ? " " + cls : "");
  };
  badge("count-backends", down ? down + " down" : String(states.length), down ? "bad" : "");
  const tools = Object.values(h.backends).reduce((sum, b) => sum + (b.tools || 0), 0);
  badge("count-tools", String(tools), "");
}

function renderNav() {
  const v = view();
  for (const a of $("nav").querySelectorAll("a")) {
    if (a.dataset.view === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const part of document.querySelectorAll("[data-for]")) part.hidden = part.dataset.for !== v;
  document.body.className = "view-" + v;
  $("window").hidden = !WINDOWED.includes(v);
  document.title = v === "overview" ? "mcp-gateway" : v[0].toUpperCase() + v.slice(1) + ", mcp-gateway";
}

/** Backends converge on the gate and leave as profiles: the logo, live. */
function renderMap(h, s) {
  const map = $("map");
  const backends = Object.entries(h.backends).map(([name, b]) => {
    const r = rowFor(s && s.servers, name);
    return { name, state: b.state, sub: [b.tools + " tools", num(r.calls) + " calls"], calls: r.calls, live: (s && s.live[name]) || 0 };
  }).concat((h.disabled || []).map((name) => ({ name, state: "disabled", sub: ["disabled"], calls: 0, live: 0 })));
  const profiles = Object.entries(h.profile_detail || {}).map(([name, p]) => {
    const r = rowFor(s && s.profiles, name);
    const sub = [p.tools + " tools", p.sessions === 1 ? "1 client" : p.sessions + " clients"];
    if (p.context) sub.push(p.context.tools === "lazy" ? "lazy tools" : "handles");
    return { name, sessions: p.sessions, sub, calls: r.calls };
  });

  const ROW = 68, PAD = 34, W = 1000;
  const n = Math.max(backends.length, profiles.length, 1);
  const H = PAD * 2 + n * ROW;
  const cy = H / 2;
  const y = (i, count) => cy + (i - (count - 1) / 2) * ROW;
  const weight = (calls) => 2 + Math.min(7, Math.log2(1 + calls) * 1.1);
  const GATE_L = 430, GATE_R = 570;
  map.setAttribute("viewBox", "0 0 " + W + " " + H);
  const kids = [];

  const track = (x1, y1, x2, y2, state, calls, live) => {
    const mid = (x1 + x2) / 2;
    const d = "M" + x1 + " " + y1 + " C" + mid + " " + y1 + " " + mid + " " + y2 + " " + x2 + " " + y2;
    kids.push(shape("path", { d, class: "track " + state, "stroke-width": weight(calls) }));
    if (live) kids.push(shape("path", { d, class: "train", "stroke-width": Math.max(3, weight(calls) - 1) }));
  };
  const label = (x, yy, anchor, item) => {
    const name = item.name.length > 20 ? item.name.slice(0, 19) + "…" : item.name;
    const t = shape("text", { x, y: yy - 5, "text-anchor": anchor, class: "m-name" }, name);
    if (name !== item.name) t.appendChild(shape("title", {}, item.name));
    kids.push(t);
    // Spaced with tspans: SVG collapses runs of spaces.
    const sub = shape("text", { x, y: yy + 17, "text-anchor": anchor, class: "m-sub" });
    item.sub.forEach((part, i) => sub.appendChild(shape("tspan", i ? { dx: 14 } : {}, part)));
    kids.push(sub);
  };
  const lamp = (x, yy, state) => {
    kids.push(shape("circle", { cx: x, cy: yy, r: 8, class: "m-halo " + state }));
    kids.push(shape("circle", { cx: x, cy: yy, r: 5, class: "m-lamp " + state }));
  };

  if (!backends.length) {
    kids.push(shape("text", { x: 0, y: cy + 5, class: "m-empty" }, "No backends yet. Add one under servers: in config.yaml."));
  }
  backends.forEach((b, i) => {
    const yy = y(i, backends.length);
    track(246, yy, GATE_L + 6, cy, b.state, b.calls, b.live);
    label(222, yy, "end", b);
    lamp(236, yy, b.state);
  });
  profiles.forEach((p, i) => {
    const yy = y(i, profiles.length);
    const busy = p.sessions || p.calls;
    track(GATE_R - 6, cy, 754, yy, busy ? "up" : "idle", p.calls, 0);
    lamp(764, yy, p.sessions ? "up" : "idle");
    label(780, yy, "start", p);
  });
  kids.push(shape("rect", { x: GATE_L, y: cy - 40, width: GATE_R - GATE_L, height: 80, rx: 40, class: "m-gate" }));
  kids.push(shape("text", { x: (GATE_L + GATE_R) / 2, y: cy - 3, "text-anchor": "middle", class: "m-gate-text" }, "gateway"));
  kids.push(shape("text", { x: (GATE_L + GATE_R) / 2, y: cy + 18, "text-anchor": "middle", class: "m-gate-sub" },
    (s ? num(s.totals.calls) : "–") + " calls in " + windowName));
  map.replaceChildren(...kids);
}

function ledger(id, s, full) {
  const t = s.totals;
  const items = [
    [num(t.calls), "tool calls in " + WINDOW_WORDS[s.window]],
    [t.calls ? (Math.floor((t.ok / t.calls) * 1000) / 10) + "%" : "–", "succeeded"],
    [num(t.refused), "refused", t.refused ? "warn" : ""],
    [num(t.errors), t.timeouts ? "failed, " + t.timeouts + " timed out" : "failed", t.errors ? "bad" : ""],
    [ms(s.latency.p95), "95th percentile"],
  ];
  if (full) {
    items.splice(4, 0, [ms(s.latency.p50), "median time"]);
    items.push([ms(s.latency.p99), "99th percentile"], [bytes(t.bytes), "returned to clients"]);
  }
  if (t.handles) items.push([bytes(t.kept_bytes), "kept out of context in " + t.handles + (t.handles === 1 ? " handle" : " handles")]);
  if (full && t.run_code) items.push([num(t.run_code), t.run_code === 1 ? "script run" : "scripts run"]);
  if (full && t.cached) items.push([num(t.cached), "answered from cache"]);
  if (full && t.approved) items.push([num(t.approved), "approved by a person"]);
  if (full) items.push([num(t.sessions), t.sessions === 1 ? "session opened" : "sessions opened"]);
  $(id).replaceChildren(...items.map(([value, label, cls]) => {
    const d = node("div");
    d.append(node("dd", cls || null, value), node("dt", null, label));
    return d;
  }));
}

function chart(id, s) {
  const W = 1000, H = 196, TOP = 12, BOTTOM = 162, RIGHT = 940;
  const t = s.totals;
  const n = s.series.length;
  const max = Math.max(1, ...s.series.map((b) => b.ok + b.refused + b.error));
  const step = RIGHT / n, gap = Math.max(2, step * 0.18);
  const scale = (v) => (v / max) * (BOTTOM - TOP);
  const kids = [];
  for (const v of [max, Math.round(max / 2)]) {
    const yy = BOTTOM - scale(v);
    kids.push(shape("line", { x1: 0, x2: RIGHT, y1: yy, y2: yy, class: "grid" }));
    kids.push(shape("text", { x: RIGHT + 8, y: yy + 5 }, num(v)));
  }
  kids.push(shape("line", { x1: 0, x2: RIGHT, y1: BOTTOM, y2: BOTTOM, class: "grid" }));
  const every = n <= 12 ? 3 : n <= 24 ? 6 : 4;
  s.series.forEach((b, i) => {
    const x = i * step + gap / 2, w = step - gap;
    let base = BOTTOM;
    const when = new Date(b.t);
    const at = s.window === "7d"
      ? when.toLocaleDateString(undefined, { weekday: "short" }) + " " + when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const g = shape("g", {});
    g.appendChild(shape("title", {}, at + ": " + b.ok + " succeeded, " + b.refused + " refused, " + b.error + " failed"));
    for (const [k, cls] of [["ok", "b-ok"], ["refused", "b-refused"], ["error", "b-error"]]) {
      if (!b[k]) continue;
      const hgt = Math.max(1.5, scale(b[k]));
      base -= hgt;
      g.appendChild(shape("rect", { x, y: base, width: w, height: hgt, rx: Math.min(2, w / 4), class: cls }));
    }
    // An invisible full-height target, so the tooltip works on an empty bucket too.
    g.appendChild(shape("rect", { x, y: TOP, width: w, height: BOTTOM - TOP, fill: "transparent" }));
    kids.push(g);
    if (i % every === 0) kids.push(shape("text", { x: x, y: BOTTOM + 24 }, at));
  });
  if (!t.calls) {
    kids.push(shape("text", { x: RIGHT / 2, y: (TOP + BOTTOM) / 2, "text-anchor": "middle" },
      "No tool calls in " + WINDOW_WORDS[s.window] + ". Connect a client to a profile to see traffic here."));
  }
  const svg = shape("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Tool calls over " + WINDOW_WORDS[s.window] });
  svg.replaceChildren(...kids);
  $(id).replaceChildren(svg);
}

function renderAttention(h, s, recent) {
  const items = [];
  const item = (lamp, text, link, label) => {
    const li = node("li");
    li.append(node("span", "lamp " + lamp), node("span", null, text));
    if (link) {
      const a = node("a", "more", label);
      a.href = link;
      li.append(a);
    }
    items.push(li);
  };
  for (const [name, b] of Object.entries(h.backends)) {
    if (b.state === "down") item("down", name + " is down" + (b.error ? ": " + b.error : "") + ".", "#/backends", "Open backends");
    if (b.state === "connecting") item("connecting", name + " is still connecting.", "#/backends", "Open backends");
  }
  if (h.pending_drift) {
    item("connecting", h.pending_drift + (h.pending_drift === 1 ? " tool changed" : " tools changed") +
      " since it was pinned. Review with mcpgw pin.");
  }
  if (s && s.totals.errors) {
    item("down", num(s.totals.errors) + (s.totals.errors === 1 ? " call" : " calls") + " failed in " + WINDOW_WORDS[s.window] + ".",
      "#/activity", "See activity");
  }
  if (s && s.totals.refused) {
    item("connecting", num(s.totals.refused) + (s.totals.refused === 1 ? " call was" : " calls were") + " refused in " + WINDOW_WORDS[s.window] + ".",
      "#/traffic", "See why");
  }
  // The same tool refused for the same reason is one line with a count, newest first.
  const seen = new Map();
  for (const l of ((recent && recent.lines) || []).filter((l) => l.method === "tools/call").reverse()) {
    const what = l.exposed_as || (l.tool ? l.server + "__" + l.tool : l.method);
    const why = l.status === "denied" ? (REASONS[l.decision] || l.decision || "refused") : (l.error ? l.error.message : l.status);
    const key = what + "|" + why;
    if (seen.has(key)) seen.get(key).times++;
    else seen.set(key, { what, why, times: 1, ts: l.ts, refused: l.status === "denied" });
  }
  for (const e of [...seen.values()].slice(0, 4)) {
    item(e.refused ? "connecting" : "down",
      e.what + ": " + e.why + (e.times > 1 ? ", " + e.times + " times" : "") + ". Last at " +
      new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".");
  }
  if (!items.length) item("up", "Nothing needs attention. Every backend is up and nothing failed in " + (s ? WINDOW_WORDS[s.window] : "this window") + ".");
  $("attention").replaceChildren(...items);
}

function renderTraffic(h, s) {
  ledger("ledger", s, true);
  $("partial").hidden = !s.partial;
  chart("chart", s);

  const body = $("top-tools");
  body.replaceChildren();
  const top = s.tools.slice(0, 15);
  const most = Math.max(1, ...top.map((r) => r.calls));
  for (const r of top) {
    const row = body.insertRow();
    cell(row, r.key);
    const meter = node("div", "meter");
    const bar = node("i");
    bar.style.width = Math.max(2, (r.calls / most) * 140) + "px";
    meter.append(bar, node("span", null, num(r.calls)));
    row.insertCell().appendChild(meter);
    cell(row, r.errors || "", "num" + (r.errors ? " bad" : ""));
    cell(row, r.refused || "", "num" + (r.refused ? " warn" : ""));
    cell(row, ms(r.p95_ms), "num");
  }
  if (!top.length) emptyRow(body, "No tool has been called in " + WINDOW_WORDS[s.window] + ".", 5);

  const tally = (id, rows, empty, label) => {
    const list = $(id);
    const peak = Math.max(1, ...rows.map((r) => r.count));
    list.replaceChildren(...rows.map((r) => {
      const li = node("li");
      const bar = node("i");
      bar.style.width = Math.max(2, (r.count / peak) * 100) + "%";
      li.append(node("span", null, label(r.key)), node("span", null, num(r.count)), bar);
      return li;
    }));
    if (!rows.length) list.replaceChildren(node("li", "empty", empty));
  };
  tally("reasons", s.reasons, "Nothing was refused in " + WINDOW_WORDS[s.window] + ".", (k) => REASONS[k] || k);
  tally("clients", s.clients.map((c) => ({ key: c.key, count: c.calls })), "No client has called a tool yet.", (k) => k);

  const profiles = $("profiles");
  profiles.replaceChildren();
  for (const [name, p] of Object.entries(h.profile_detail || {})) {
    const r = rowFor(s.profiles, name);
    const row = profiles.insertRow();
    const who = node("span", "name");
    who.append(node("span", "lamp " + (p.sessions ? "up" : "")), node("span", null, name));
    row.insertCell().appendChild(who);
    cell(row, p.tools, "num"); cell(row, p.sessions, "num"); cell(row, num(r.calls), "num");
    cell(row, r.errors || "", "num" + (r.errors ? " bad" : "")); cell(row, r.refused || "", "num" + (r.refused ? " warn" : ""));
    cell(row, ms(r.p95_ms), "num");
    const c = p.context;
    cell(row, c ? [c.tools === "lazy" ? "lazy tools" : "", c.handle_bytes ? "handles over " + bytes(c.handle_bytes) : "", c.code ? "run_code" : ""].filter(Boolean).join(", ") : "", "muted");
  }
}

function renderBackends(h, s) {
  const backends = $("backends");
  backends.replaceChildren();
  for (const [name, b] of Object.entries(h.backends)) {
    const r = rowFor(s && s.servers, name);
    const row = backends.insertRow();
    const who = node("span", "name");
    who.append(node("span", "lamp " + b.state), node("span", null, name));
    row.insertCell().appendChild(who);
    cell(row, b.state, b.state === "up" ? "ok" : b.state === "connecting" ? "warn" : "bad");
    cell(row, b.transport, "muted");
    cell(row, b.tools, "num"); cell(row, num(r.calls), "num");
    cell(row, r.errors || "", "num" + (r.errors ? " bad" : "")); cell(row, ms(r.p95_ms), "num");
    cell(row, b.restarts, "num"); cell(row, b.pid, "num muted"); cell(row, b.error, "wrap bad");
    const actions = row.insertCell();
    if (!h.manage) continue;
    button(actions, "Restart", (b) => act(b, "/restart/" + encodeURIComponent(name), (r) =>
      r.status === 200
        ? say(name + " restarted: " + r.body.status + (r.body.error ? ", " + r.body.error : ""), r.body.status !== "up")
        : say("Restart failed: " + ((r.body && r.body.error) || r.status), true)));
    button(actions, "Disable", (b) => {
      if (!confirm("Disable " + name + "? Its process stops and its tools disappear from every profile.")) return;
      act(b, "/servers/" + encodeURIComponent(name) + "/disable", saved("Disable " + name));
    });
  }
  for (const name of h.disabled || []) {
    const row = backends.insertRow();
    const who = node("span", "name");
    who.append(node("span", "lamp"), node("span", null, name));
    row.insertCell().appendChild(who);
    cell(row, "disabled", "muted");
    for (let i = 0; i < 8; i++) cell(row, "");
    const actions = row.insertCell();
    if (h.manage) button(actions, "Enable", (b) => act(b, "/servers/" + encodeURIComponent(name) + "/enable", saved("Enable " + name)));
  }
  if (!backends.rows.length) emptyRow(backends, "No backends configured. Add one under servers: in config.yaml, then reload.", 11);
}

async function loadTools(h) {
  const select = $("profile");
  if ([...select.options].map((o) => o.value).join() !== h.profiles.join()) {
    const keep = select.value || prefs.get("profile", "");
    select.replaceChildren(...h.profiles.map((p) => new Option(p, p, false, p === keep)));
  }
  const profile = select.value;
  if (!profile) return;
  const list = await get("/profiles/" + encodeURIComponent(profile) + "/tools");
  last.tools = { profile, tools: (list.body && list.body.tools) || [] };
}

/** One folded group per backend, so a profile with hundreds of tools stays readable. */
function renderTools() {
  const h = last.health;
  const list = last.tools;
  $("tools-note").hidden = !(h && h.manage);
  if (!h || !list) return;
  const query = $("tool-search").value.trim().toLowerCase();
  const all = list.tools;
  const allowed = all.filter((t) => t.allow).length;
  $("tool-tally").textContent = all.length + " tools, " + allowed + " allowed, " + (all.length - allowed) + " blocked";
  const shown = all.filter((t) =>
    (toolShow === "all" || (toolShow === "allowed") === t.allow) &&
    (!query || t.tool.toLowerCase().includes(query) || t.canonical.toLowerCase().includes(query)));

  const groups = new Map();
  for (const t of shown) {
    const server = t.canonical.split("__")[0];
    if (!groups.has(server)) groups.set(server, []);
    groups.get(server).push(t);
  }
  const usage = new Map(((last.stats && last.stats.tools) || []).map((r) => [r.key, r]));
  const out = [];
  for (const [server, tools] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = node("details", "group");
    d.open = Boolean(query) || !folded.has(server);
    d.addEventListener("toggle", () => { if (!query) d.open ? folded.delete(server) : folded.add(server); });
    const sum = node("summary");
    const who = node("span", "name");
    const b = h.backends[server];
    who.append(node("span", "lamp " + (b ? b.state : "")), node("span", null, server));
    const blocked = tools.filter((t) => !t.allow).length;
    sum.append(who, node("span", "tally-line", tools.length + (tools.length === 1 ? " tool" : " tools") + (blocked ? ", " + blocked + " blocked" : "")));
    d.append(sum);
    const table = node("table");
    table.innerHTML = "<colgroup><col class=\"c-tool\"><col class=\"c-decision\"><col class=\"c-rule\"><col class=\"c-num\"><col class=\"c-num\"><col class=\"c-act\"></colgroup>" +
      "<thead><tr><th>Tool</th><th>Decision</th><th>Rule</th><th class=\"num\">Calls</th><th class=\"num\">p95</th><th></th></tr></thead>";
    const body = table.createTBody();
    for (const t of tools) {
      const row = body.insertRow();
      const short = t.canonical.slice(server.length + 2);
      const name = cell(row, short);
      name.title = t.canonical;
      if (t.tool !== t.canonical) name.append(" ", node("span", "alias", "as " + t.tool));
      cell(row, t.allow ? "Allowed" : (REASONS[t.reason] || t.reason), t.allow ? "ok" : "bad");
      cell(row, t.rule, "muted");
      const u = usage.get(t.canonical);
      cell(row, u ? num(u.calls) : "", "num"); cell(row, u ? ms(u.p95_ms) : "", "num");
      const actions = row.insertCell();
      if (!h.manage || !t.toggle) continue;
      const path = "/profiles/" + encodeURIComponent(list.profile) + "/tools/" + encodeURIComponent(t.canonical) + "/" + t.toggle;
      button(actions, t.toggle === "disable" ? "Disable" : "Enable", (b) =>
        act(b, path, saved((t.toggle === "disable" ? "Deny " : "Allow ") + t.canonical + " in " + list.profile)));
    }
    const scroll = node("div", "scroll");
    scroll.append(table);
    d.append(scroll);
    out.push(d);
  }
  if (!out.length) {
    out.push(node("p", "empty", all.length
      ? "No tool in " + list.profile + " matches. Clear the search or show all tools."
      : list.profile + " exposes no tools yet. Check that its backends are up."));
  }
  $("tool-groups").replaceChildren(...out);
}

function renderActivity() {
  const audit = $("audit");
  audit.replaceChildren();
  const query = $("activity-search").value.trim().toLowerCase();
  const lines = ((last.recent && last.recent.lines) || []).slice().reverse();
  let shown = 0;
  for (const line of lines) {
    // A tool call names its tool; anything else (a refused reverse request, say) names what it was.
    const what = line.exposed_as || (line.tool ? line.server + "__" + line.tool
      : [line.server, line.rpc_method || line.method].filter(Boolean).join(" "));
    const client = line.client && line.client.name;
    if (query && ![what, client, line.profile].some((v) => v && String(v).toLowerCase().includes(query))) continue;
    shown++;
    const row = audit.insertRow();
    const when = new Date(line.ts);
    const td = cell(row, isNaN(when) ? "" : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), "muted");
    td.title = line.ts || "";
    cell(row, client);
    cell(row, line.profile);
    cell(row, what);
    const refused = line.status === "denied" || (line.decision && line.decision !== "allow");
    const failed = line.status === "error" || line.status === "timeout";
    const outcome = refused ? (REASONS[line.decision] || line.decision || "refused")
      : failed ? (line.status === "timeout" ? "timed out" : "failed") + (line.error ? ": " + line.error.message : "")
      : line.method === "handle" ? "kept out of context as " + line.handle
      : line.status === "ok" ? (line.cached ? "ok, from cache" : "ok") : (line.status || "");
    const o = cell(row, outcome, refused ? "warn" : failed ? "bad" : "muted");
    if (failed) o.className += " wrap";
    cell(row, line.dur_ms != null ? ms(line.dur_ms) : "", "num");
    cell(row, line.result_bytes != null ? bytes(line.result_bytes) : "", "num muted");
  }
  if (!shown) {
    emptyRow(audit, query ? "Nothing in the latest 200 lines matches. Clear the filter to see them all."
      : filter === "denied" ? "Nothing refused or failed today." : "Nothing logged yet today.", 7);
  }
}

function renderFacts(h) {
  const facts = [
    ["Version", "mcp-gateway " + (h.version || "")], ["Node", h.node], ["Process", "pid " + h.pid],
    ["Memory", (h.memory_mb || 0) + " MB"], ["Listening on", h.listen || location.origin],
    ["Running for", since(h.uptime_s)], ["Profiles", h.profiles.join(", ")],
    ["Disabled backends", (h.disabled || []).join(", ") || "none"],
    ["Management", h.manage ? "on, with listen.token" : "read-only: set listen.token to manage from this page"],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, v]) => [node("dt", null, k), node("dd", null, v)]));
}

function pressed(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value));
}

async function refresh() {
  renderNav();
  // A gateway that stopped must not go on looking up: a failed fetch is an answer too.
  const health = await get("/healthz").catch(() => ({ status: 0, body: null }));
  const detail = health.body && health.body.backends;
  $("login").hidden = Boolean(detail) || !health.body;
  $("controls").hidden = !(detail && health.body.manage);
  $("nav").hidden = !detail;
  $("detail").hidden = !detail;
  if (!detail) {
    $("window").hidden = true;
    $("summary").replaceChildren(node("span", "lamp " + (health.body ? "up" : "down")),
      node("span", health.body ? null : "bad", health.body
        ? "Running. Enter the gateway token to see detail."
        : "Not answering. Start it with mcpgw start, then this page reconnects."));
    return;
  }
  const h = (last.health = health.body);
  const v = view();
  renderSummary(h);

  // Each view fetches only what it shows.
  const wants = {
    stats: WINDOWED.includes(v) || v === "activity",
    recent: v === "overview" || v === "activity",
  };
  const [stats, recent] = await Promise.all([
    wants.stats ? get("/audit/stats?window=" + windowName).catch(() => ({ body: null })) : { body: last.stats },
    wants.recent
      ? get(v === "overview" ? "/audit/recent?n=40&denied=1" : "/audit/recent?n=200" + (filter === "denied" ? "&denied=1" : "")).catch(() => ({ body: null }))
      : { body: null },
  ]);
  const s = (last.stats = stats.body);
  if (s) $("count-activity").hidden = !s.totals.refused && !s.totals.errors;
  if (s) {
    $("count-activity").textContent = num(s.totals.refused + s.totals.errors);
    $("count-activity").className = "count " + (s.totals.errors ? "bad" : "warn");
  }

  if (v === "overview") {
    renderMap(h, s);
    renderAttention(h, s, recent.body);
    if (s) { ledger("overview-ledger", s, false); chart("overview-chart", s); }
  } else if (v === "traffic") {
    if (s) renderTraffic(h, s);
  } else if (v === "backends") {
    renderBackends(h, s);
  } else if (v === "tools") {
    await loadTools(h);
    renderTools();
  } else if (v === "activity") {
    last.recent = recent.body;
    renderActivity();
  } else if (v === "config") {
    refreshEditor(h);
    renderFacts(h);
  }
}

$("window").addEventListener("click", (e) => {
  const value = e.target.closest("button") && e.target.closest("button").dataset.window;
  if (!value) return;
  windowName = value; prefs.set("window", value); pressed("window", "data-window", value);
  refresh().catch(() => {});
});
$("filter").addEventListener("click", (e) => {
  const value = e.target.closest("button") && e.target.closest("button").dataset.filter;
  if (!value) return;
  filter = value; prefs.set("filter", value); pressed("filter", "data-filter", value);
  refresh().catch(() => {});
});
$("tool-filter").addEventListener("click", (e) => {
  const value = e.target.closest("button") && e.target.closest("button").dataset.show;
  if (!value) return;
  toolShow = value; prefs.set("tools-show", value); pressed("tool-filter", "data-show", value);
  renderTools();
});
$("tool-search").addEventListener("input", () => renderTools());
$("activity-search").addEventListener("input", () => renderActivity());
$("profile").addEventListener("change", () => { prefs.set("profile", $("profile").value); refresh().catch(() => {}); });
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); refresh().catch(() => {}); });
pressed("window", "data-window", windowName);
pressed("filter", "data-filter", filter);
pressed("tool-filter", "data-show", toolShow);

$("login").addEventListener("submit", (e) => { e.preventDefault(); store.set($("token").value); refresh(); });
$("editor-load").addEventListener("click", () => {
  if (!confirm("Replace the text below with config.yaml as it is on disk? Unsaved edits are lost.")) return;
  loadEditor().then(() => say("Loaded config.yaml.")).catch(() => say("Could not load config.yaml.", true));
});
$("editor-validate").addEventListener("click", async () => {
  try {
    const r = await sendJson("POST", "/config/validate", { text: $("editor").value });
    r.status === 200
      ? say("Valid." + (r.body.restart_needed ? " The listen block changed, which needs mcpgw start again." : ""))
      : say("Invalid:\n" + problems(r), true);
  } catch {
    say("The gateway did not answer.", true);
  }
});
$("editor-save").addEventListener("click", async () => {
  const b = $("editor-save");
  b.disabled = true;
  try {
    const r = await sendJson("PUT", "/config", { text: $("editor").value, base_hash: editorHash });
    if (r.status === 200) {
      editorHash = r.body.hash;
      editorText = $("editor").value;
      say("Saved and reloaded." + (r.body.restart_needed ? " The listen block changed; restart the gateway to apply it." : ""));
    } else {
      say("Not saved, config.yaml unchanged:\n" + problems(r), true);
    }
  } catch {
    say("The gateway did not answer.", true);
  } finally {
    b.disabled = false;
    refresh().catch(() => {});
  }
});
$("reload").addEventListener("click", () => act($("reload"), "/reload", (r) =>
  r.status === 200
    ? say("Config reloaded.")
    : say("Config unchanged:\n" + ((r.body && (r.body.problems || [r.body.error]).join("\n")) || r.status), true)));
$("stop").addEventListener("click", () => {
  if (!confirm("Stop the gateway? Every client loses its connection, and nothing on this page can start it again.")) return;
  act($("stop"), "/stop", (r) =>
    r.status === 202
      ? say("Stopping. Run mcpgw start to bring it back.")
      : say("Stop failed: " + ((r.body && r.body.error) || r.status), true));
});
$("theme").addEventListener("click", (e) => {
  const value = e.target.closest("button") && e.target.closest("button").dataset.themeChoice;
  if (!value) return;
  themeChoice = value; prefs.set("theme", value); applyTheme(value); pressed("theme", "data-theme-choice", value);
  // The diagram and chart read colours through CSS, so nothing needs redrawing.
});
pressed("theme", "data-theme-choice", themeChoice);

refresh().catch(() => { $("summary").textContent = "Not answering."; });
setInterval(() => refresh().catch(() => {}), 5000);
}
`;
