"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "@/app/docs/docs.module.css";

type Heading = { id: string; text: string; level: number };

/**
 * On this page. Read from the rendered article, because visited routes stay mounted but hidden
 * (Cache Components keeps them in an Activity), so only the visible article counts.
 */
export function Toc() {
  const path = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    // Read on the next task, once a page being revealed is actually visible (a timeout, not an
    // animation frame, which never fires in a background tab). Hidden pages can sit in the same
    // article, so each heading is checked, not the container.
    const timer = setTimeout(() => {
      const elements = [...document.querySelectorAll<HTMLElement>("[data-doc] h2[id], [data-doc] h3[id]")].filter((h) =>
        h.checkVisibility(),
      );
      setHeadings(elements.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H3" ? 3 : 2 })));
      for (const el of elements) observer.observe(el);
    }, 0);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [path]);

  if (headings.length < 2) return <aside className={styles.toc} />;
  return (
    <aside className={styles.toc} aria-label="On this page">
      <p className={styles.navHeading}>On this page</p>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? styles.tocSub : undefined}>
            <a href={`#${h.id}`} aria-current={h.id === active ? "location" : undefined}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
