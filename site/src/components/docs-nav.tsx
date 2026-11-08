"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS } from "@/lib/site";
import styles from "@/app/docs/docs.module.css";

/** The sidebar; on a phone it folds into one disclosure above the page. */
export function DocsNav() {
  const path = usePathname();
  const current = DOCS.flatMap((g) => g.pages).find((p) => p.href === path);

  const list = (
    <>
      {DOCS.map((group) => (
        <div key={group.group} className={styles.navGroup}>
          <p className={styles.navHeading}>{group.group}</p>
          <ul>
            {group.pages.map((p) => (
              <li key={p.href}>
                <Link href={p.href} aria-current={p.href === path ? "page" : undefined}>
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );

  return (
    <nav className={styles.nav} aria-label="Documentation">
      <div className={styles.navWide}>{list}</div>
      <details className={styles.navNarrow}>
        <summary>{current ? current.title : "Pages"}</summary>
        {list}
      </details>
    </nav>
  );
}

/** The end of a page: where to read next, in sidebar order. */
export function DocsPager() {
  const path = usePathname();
  const flat = DOCS.flatMap((g) => g.pages);
  const index = flat.findIndex((p) => p.href === path);
  const prev = index > 0 ? flat[index - 1] : undefined;
  const next = index >= 0 ? flat[index + 1] : undefined;
  if (!prev && !next) return null;
  return (
    <nav className={styles.pager} aria-label="Previous and next page">
      {prev ? (
        <Link href={prev.href} rel="prev">
          <span>Previous</span>
          {prev.title}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={next.href} rel="next" className={styles.pagerNext}>
          <span>Next</span>
          {next.title}
        </Link>
      ) : null}
    </nav>
  );
}
