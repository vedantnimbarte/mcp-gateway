# mcp-gateway website

The public site for mcp-gateway: a landing page and the docs. Next.js 16 with the App Router; the
docs are MDX pages under `src/app/docs/`.

It lives in the gateway's repository so docs can change in the same commit as the code they
describe, but it is its own npm project: none of this touches the gateway's dependencies.

## Run it locally

```bash
cd site
npm install
npm run dev
```

Then open http://localhost:3000.

## Where things are

| Path | What it is |
|------|------------|
| `src/app/page.tsx` | The landing page |
| `src/components/track-diagram.tsx` | The hero diagram: pure SVG and CSS, no client JavaScript |
| `src/app/docs/*/page.mdx` | One folder per docs page |
| `src/lib/site.ts` | The docs sidebar order, the repository URL and the install command |
| `src/mdx-components.tsx` | How MDX renders links, code blocks and tables |
| `public/dashboard.png` | A capture of the gateway's status page |

To add a docs page, create `src/app/docs/<slug>/page.mdx` with `export const metadata = { title: "…" }`
at the top, and add it to `DOCS` in `src/lib/site.ts`. Headings get anchors and the on-page
contents list automatically; fenced code blocks get highlighting and a copy button, and
` ```yaml title="config.yaml" ` adds a file name.

## Deploy on Vercel

1. Import the `vedantnimbarte/mcp-gateway` repository in Vercel.
2. Set **Root Directory** to `site`. Vercel then detects Next.js and uses `npm run build`.
3. Deploy. Nothing else needs configuring; there are no environment variables.

Every page is prerendered, so the site serves as static content.
