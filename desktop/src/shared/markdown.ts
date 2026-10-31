/**
 * A small Markdown reader for AI output. It produces plain data, never HTML, so nothing a model writes
 * can run or load anything. Only `cite:` links survive; any other link becomes its visible text.
 */

export type Inline = { type: 'text'; text: string } | { type: 'bold'; children: Inline[] } | { type: 'italic'; children: Inline[] } | { type: 'code'; text: string } | { type: 'cite'; label: string; ms: number };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: { children: Inline[]; depth: number }[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'rule' };

const INLINE = /(\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ type: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) });
    if (m[2] !== undefined || m[3] !== undefined) out.push({ type: 'bold', children: parseInline(m[2] ?? m[3]!) });
    else if (m[4] !== undefined) out.push({ type: 'italic', children: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ type: 'code', text: m[5] });
    else {
      const cite = /^cite:(\d+)$/.exec(m[7]!);
      if (cite) out.push({ type: 'cite', label: m[6]!, ms: Number(cite[1]) });
      else out.push({ type: 'text', text: m[6]! });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, children: parseInline(heading[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      const header = tableCells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(tableCells(lines[i]!).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const entry = { children: parseInline(item[3]!), depth: Math.min(3, Math.floor(item[1]!.length / 2)) };
      const last = blocks[blocks.length - 1];
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(entry);
      else blocks.push({ type: 'list', ordered, items: [entry] });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ type: 'quote', children: parseInline(quote[1]!) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Plain text for copying. Citations become readable times. */
export function markdownToClipboard(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(cite:\d+\)/g, '[$1]');
}
