import type { Metadata } from "next";
import { Barlow, Barlow_Semi_Condensed, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import { GateMark } from "@/components/gate-mark";
import { SiteNav } from "@/components/site-nav";
import { REPO } from "@/lib/site";
import "./globals.css";

const barlow = Barlow({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-barlow" });
const barlowSemi = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow-semi",
});
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: { default: "mcp-gateway: one local gateway for all your MCP servers", template: "%s | mcp-gateway" },
  description:
    "A local daemon in front of all your MCP servers: one config for every client, curated tool profiles, allow and deny policy, an audit log, and tools that keep the model's context small.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowSemi.variable} ${plexMono.variable}`}>
      <body>
        <a className="sr-only" href="#content">
          Skip to content
        </a>
        <header className="site-header">
          <div className="wrap">
            <Link className="brand" href="/">
              <GateMark />
              <span>mcp-gateway</span>
            </Link>
            <SiteNav />
          </div>
        </header>
        <div id="content">{children}</div>
        <footer className="site-footer">
          <div className="wrap">
            <span>mcp-gateway is MIT licensed.</span>
            <Link href="/docs">Docs</Link>
            <Link href="/docs/quick-start">Quick start</Link>
            <a href={REPO}>Source on GitHub</a>
            <a href={`${REPO}/issues`}>Report an issue</a>
            <span className="spacer">Runs on your machine. Nothing here phones home.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
