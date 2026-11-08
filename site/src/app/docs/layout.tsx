import { DocsNav, DocsPager } from "@/components/docs-nav";
import { Toc } from "@/components/toc";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.sheet}>
      <div className={`wrap ${styles.grid}`}>
        <DocsNav />
        <article className={styles.article} data-doc>
          {children}
          <DocsPager />
        </article>
        <Toc />
      </div>
    </div>
  );
}
