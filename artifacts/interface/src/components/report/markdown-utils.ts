// A tiny, tolerant markdown parser for the AI report and the actions inbox.
// Produces a flat block list that the on-screen renderers (report + actions)
// and the PDF renderer consume, so they stay consistent. Intentionally minimal:
// headings, bullet lists, paragraphs, and inline **bold**, *italic*, `code`, and
// [links](url). It tolerates partial/streaming input (e.g. an unclosed **bold**)
// without throwing.

export type Inline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
};

// Only allow http(s) links to be rendered as anchors. Anything else
// (javascript:, data:, mailto:, relative, etc.) is rejected so a malicious
// agent-authored or imported link can't execute script when clicked. Callers
// render the link text as plain prose when this returns null.
export function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; items: Inline[][] };

// Inline tokenizer. Walks the string once, peeling off the next markdown span
// (link, bold, code, italic) or accumulating plain text. Order matters: links
// and **bold** are matched before single-char *italic* so `**x**` never reads as
// italic. Unmatched/unclosed delimiters fall through as plain text, which keeps
// streaming input safe.
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      out.push({ text: plain });
      plain = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flushPlain();
      out.push({ text: link[1], href: link[2] });
      i += link[0].length;
      continue;
    }

    const bold = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (bold) {
      flushPlain();
      out.push({ text: bold[1], bold: true });
      i += bold[0].length;
      continue;
    }

    const code = /^`([^`]+?)`/.exec(rest);
    if (code) {
      flushPlain();
      out.push({ text: code[1], code: true });
      i += code[0].length;
      continue;
    }

    const italic =
      /^\*([^*\s][^*]*?)\*/.exec(rest) || /^_([^_\s][^_]*?)_/.exec(rest);
    if (italic) {
      flushPlain();
      out.push({ text: italic[1], italic: true });
      i += italic[0].length;
      continue;
    }

    plain += src[i];
    i += 1;
  }

  flushPlain();
  if (out.length === 0) out.push({ text: "" });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let listItems: Inline[][] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ").trim()) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, inlines: parseInline(heading[2].trim()) });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      listItems.push(parseInline(bullet[1].trim()));
      continue;
    }

    // Plain text line: accumulate into the current paragraph (and end any list).
    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}
