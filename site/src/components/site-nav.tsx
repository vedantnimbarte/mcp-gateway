"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { REPO } from "@/lib/site";

export function SiteNav() {
  const path = usePathname();
  const docs = path.startsWith("/docs") && path !== "/docs/quick-start";
  return (
    <nav className="site-nav" aria-label="Site">
      <Link href="/docs" aria-current={docs ? "page" : undefined}>
        Docs
      </Link>
      <Link href="/docs/quick-start" aria-current={path === "/docs/quick-start" ? "page" : undefined}>
        Quick start
      </Link>
      <a href={REPO}>GitHub</a>
    </nav>
  );
}
