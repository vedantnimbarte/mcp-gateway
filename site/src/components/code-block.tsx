"use client";

import { useRef, useState, type ComponentProps } from "react";

/** A code block with a copy button. Copies the text as shown, without the highlighting markup. */
export function CodeBlock({ title, ...props }: ComponentProps<"pre"> & { title?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = ref.current?.innerText.replace(/\n$/, "") ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard refused (an insecure origin, say): the text is still there to select.
    }
  };

  return (
    <div className="code" data-title={title}>
      {title ? <div className="code-title">{title}</div> : null}
      <pre ref={ref} {...props} />
      <button type="button" className="copy" onClick={copy} data-copied={copied || undefined}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
