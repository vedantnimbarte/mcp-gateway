import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps } from "react";
import { CodeBlock } from "@/components/code-block";

/** Internal links go through next/link; everything else opens normally. */
function A({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/") || href.startsWith("#")) return <Link href={href} {...props} />;
  return <a href={href} {...props} />;
}

const components: MDXComponents = {
  a: A,
  pre: (props) => <CodeBlock {...props} />,
  table: (props) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
