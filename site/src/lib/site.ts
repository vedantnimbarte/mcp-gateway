export const REPO = "https://github.com/vedantnimbarte/mcp-gateway";
export const INSTALL = "npm install -g github:vedantnimbarte/mcp-gateway";

/** The docs sidebar, in reading order. Groups say what stage of setup a page belongs to. */
export const DOCS: { group: string; pages: { href: string; title: string }[] }[] = [
  {
    group: "Get started",
    pages: [
      { href: "/docs", title: "Introduction" },
      { href: "/docs/installation", title: "Installation" },
      { href: "/docs/quick-start", title: "Quick start" },
    ],
  },
  {
    group: "Set it up",
    pages: [
      { href: "/docs/configuration", title: "The config file" },
      { href: "/docs/servers", title: "Adding servers" },
      { href: "/docs/profiles", title: "Profiles and tools" },
      { href: "/docs/clients", title: "Connecting clients" },
    ],
  },
  {
    group: "Go further",
    pages: [
      { href: "/docs/context", title: "Keeping context small" },
      { href: "/docs/security", title: "Guarding your tools" },
      { href: "/docs/dashboard", title: "The status page" },
      { href: "/docs/audit", title: "The audit log" },
    ],
  },
  {
    group: "Reference",
    pages: [{ href: "/docs/cli", title: "Command line" }],
  },
];
