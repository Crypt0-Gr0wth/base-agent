import type { ReactNode } from "react";
import { parseMarkdown, sanitizeHref, type Inline } from "./markdown-utils";

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
                className="font-medium text-foreground underline underline-offset-2 decoration-muted-foreground/40 hover:decoration-foreground break-words"
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
            <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.9em]">
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

// Renders the AI report markdown as polished prose in the app's light theme.
// Tolerant of partial input while streaming.
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          return (
            <h3
              key={i}
              className="font-sans text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
            >
              <Inlines inlines={b.inlines} />
            </h3>
          );
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="space-y-1.5">
              {b.items.map((item, j) => (
                <li
                  key={j}
                  className="flex gap-2 font-sans text-[13px] leading-relaxed text-foreground"
                >
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>
                    <Inlines inlines={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p
            key={i}
            className="font-sans text-[13px] leading-relaxed text-foreground"
          >
            <Inlines inlines={b.inlines} />
          </p>
        );
      })}
    </div>
  );
}
