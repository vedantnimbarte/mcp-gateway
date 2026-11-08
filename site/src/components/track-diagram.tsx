import styles from "./track-diagram.module.css";

/**
 * The hero: clients on the left converge on the gateway, which routes each call to the backend
 * that owns the tool, or stops it. On load the routes set one after another, then traffic runs.
 * Pure SVG and CSS, so it costs no client JavaScript; reduced motion shows the finished panel.
 */

type Item = { name: string; sub: string; state?: "up" | "refused"; busy?: number };

const CLIENTS: Item[] = [
  { name: "Claude Code", sub: "coding profile", busy: 2.6 },
  { name: "Cursor", sub: "coding profile", busy: 3.4 },
  { name: "Claude Desktop", sub: "readonly profile", busy: 4.2 },
  { name: "Your agent", sub: "lean profile", busy: 3 },
];

const BACKENDS: Item[] = [
  { name: "github", sub: "stdio  26 tools", busy: 2.8 },
  { name: "linear", sub: "http  14 tools", busy: 3.8 },
  { name: "filesystem", sub: "stdio  11 tools", busy: 3.2 },
  { name: "figma", sub: "http, OAuth  9 tools", busy: 4.4 },
  { name: "delete_repo", sub: "refused by policy", state: "refused", busy: 3.6 },
];

function layout(compact: boolean) {
  const W = compact ? 640 : 1100;
  const ROW = compact ? 74 : 72;
  const clients = compact ? CLIENTS.slice(0, 3) : CLIENTS;
  const backends = compact ? [BACKENDS[0]!, BACKENDS[1]!, BACKENDS[4]!] : BACKENDS;
  const n = Math.max(clients.length, backends.length);
  const H = n * ROW + 40;
  const cy = H / 2;
  const y = (i: number, count: number) => cy + (i - (count - 1) / 2) * ROW;
  const g = compact
    ? { l: 262, r: 402, lampL: 168, lampR: 506, labelL: 154, labelR: 520, h: 76 }
    : { l: 470, r: 630, lampL: 232, lampR: 846, labelL: 216, labelR: 862, h: 96 };
  return { W, H, cy, y, g, clients, backends };
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
};

function Panel({ compact }: { compact: boolean }) {
  const { W, H, cy, y, g, clients, backends } = layout(compact);
  let order = 0;
  const step = () => ({ "--i": order++ }) as React.CSSProperties;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`${styles.panel} ${compact ? styles.compact : styles.wide}`}
      role="img"
      aria-labelledby={compact ? "diagram-title-c" : "diagram-title"}
    >
      <title id={compact ? "diagram-title-c" : "diagram-title"}>
        Clients connect to one gateway, which routes each tool call to the backend that owns it, or refuses it.
      </title>

      {clients.map((c, i) => {
        const yy = y(i, clients.length);
        const d = curve(g.lampL + 12, yy, g.l + 4, cy);
        return (
          <g key={c.name}>
            <path d={d} pathLength={1} className={styles.track} style={step()} />
            <path d={d} pathLength={1} className={styles.train} style={{ "--dur": `${c.busy}s` } as React.CSSProperties} />
            <circle cx={g.lampL} cy={yy} r={9} className={`${styles.halo} ${styles.up}`} />
            <circle cx={g.lampL} cy={yy} r={5.5} className={`${styles.lamp} ${styles.up}`} />
            <text x={g.labelL} y={yy - 4} textAnchor="end" className={styles.name}>{c.name}</text>
            <text x={g.labelL} y={yy + 17} textAnchor="end" className={styles.sub}>{c.sub}</text>
          </g>
        );
      })}

      {backends.map((b, i) => {
        const yy = y(i, backends.length);
        const refused = b.state === "refused";
        // A refused call runs into a buffer stop just short of its red lamp.
        const end = refused ? g.lampR - 26 : g.lampR - 12;
        const d = curve(g.r - 4, cy, end, yy);
        return (
          <g key={b.name}>
            <path d={d} pathLength={1} className={`${styles.track} ${refused ? styles.spur : ""}`} style={step()} />
            <path
              d={d}
              pathLength={1}
              className={`${styles.train} ${refused ? styles.stopped : ""}`}
              style={{ "--dur": `${b.busy}s` } as React.CSSProperties}
            />
            {refused ? <path d={`M${end + 2} ${yy - 13} V${yy + 13}`} className={styles.buffer} /> : null}
            <circle cx={g.lampR} cy={yy} r={9} className={`${styles.halo} ${refused ? styles.stop : styles.up}`} />
            <circle cx={g.lampR} cy={yy} r={5.5} className={`${styles.lamp} ${refused ? styles.stop : styles.up}`} />
            <text x={g.labelR} y={yy - 4} className={styles.name}>{b.name}</text>
            <text x={g.labelR} y={yy + 17} className={`${styles.sub} ${refused ? styles.subStop : ""}`}>
              {b.sub.split("  ").map((part, k) => (
                <tspan key={part} dx={k ? 12 : 0}>{part}</tspan>
              ))}
            </text>
          </g>
        );
      })}

      <g className={styles.gateGroup}>
        <rect x={g.l} y={cy - g.h / 2} width={g.r - g.l} height={g.h} rx={g.h / 2} className={styles.gate} />
        <text x={(g.l + g.r) / 2} y={cy - (compact ? 2 : 6)} textAnchor="middle" className={styles.gateName}>
          mcp-gateway
        </text>
        <text x={(g.l + g.r) / 2} y={cy + (compact ? 18 : 18)} textAnchor="middle" className={styles.gateSub}>
          policy, limits, audit
        </text>
      </g>
    </svg>
  );
}

export function TrackDiagram() {
  return (
    <div className={styles.frame}>
      <Panel compact={false} />
      <Panel compact />
    </div>
  );
}
