import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The gateway's own package-lock.json sits one folder up; this site is its own project.
  turbopack: { root: path.resolve(".") },
  // Docs pages are page.mdx files under src/app/docs.
  pageExtensions: ["ts", "tsx", "md", "mdx"],
};

// Plugins by name, with serializable options only: Turbopack cannot take functions.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: [
      "rehype-slug",
      [
        "rehype-pretty-code",
        { theme: { light: "github-light", dark: "github-dark-dimmed" }, keepBackground: false },
      ],
    ],
  },
});

export default withMDX(nextConfig);
