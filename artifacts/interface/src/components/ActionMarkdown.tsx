import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { parseMarkdown, sanitizeHref, type Inline } from "./report/markdown-utils";

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((seg, i) => {
        if (seg.href) {
          const safe = sanitizeHref(seg.href);
          if (safe) {
            return (
              <a
                key={i}
                href={safe}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground underline underline-offset-2 decoration-muted-foreground/50 hover:decoration-foreground break-all"
              >
                {seg.text}
              </a>
            );
          }
          return <span key={i}>{seg.text}</span>;
        }
        let node: ReactNode = seg.text;
        if (seg.code) {
          node = (
            <code className="rounded bg-foreground/10 px-1 py-0.5 text-[0.95em] break-all">
              {seg.text}
            </code>
          );
        }
        if (seg.italic) node = <em className="italic">{node}</em>;
        if (seg.bold) {
          node = (
            <strong className="font-semibold text-foreground">{node}</strong>
          );
        }
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

// Renders an action's body markdown in the compact mono style used by the
// actions inbox / history cards. Reuses the report markdown parser (headings,
// bullet lists, paragraphs, inline bold/italic/code/links) and is tolerant of
// partial input. `className` styles the wrapper (font/size/color) so callers
// keep their existing card typography.
export function ActionMarkdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cn("space-y-1.5", className)}>
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          return (
            <div key={i} className="font-semibold text-foreground">
              <Inlines inlines={b.inlines} />
            </div>
          );
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-1.5">
                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span className="min-w-0 break-words">
                    <Inlines inlines={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="break-words">
            <Inlines inlines={b.inlines} />
          </p>
        );
      })}
    </div>
  );
}
