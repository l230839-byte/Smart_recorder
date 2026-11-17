import { parseMarkdown } from './markdown';

/**
 * Formatting commands for the document editor's Markdown text. Each takes the text and the selection and
 * returns one replacement, so the editor can apply it as a single undoable edit. Pure, so it is tested
 * without a browser.
 */

export type EditCommand = 'h2' | 'h3' | 'bold' | 'italic' | 'bullets' | 'numbers' | 'quote' | 'table' | 'rule';

export interface Selection {
  start: number;
  end: number;
}

export interface Edit {
  /** Range of the original text to replace. */
  from: number;
  to: number;
  insert: string;
  /** Selection afterwards, in the new text. */
  select: Selection;
}

function lineRange(text: string, sel: Selection): Selection {
  const start = text.lastIndexOf('\n', sel.start - 1) + 1;
  // A selection that ends right at the start of a line does not include that line.
  const endAt = sel.end > sel.start && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = text.indexOf('\n', endAt);
  return { start, end: nl === -1 ? text.length : nl };
}

const HEADING = /^#{1,6}\s+/;
const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d+[.)]\s+/;
const QUOTE = /^>\s?/;

function strip(line: string): string {
  return line.replace(HEADING, '').replace(QUOTE, '').replace(BULLET, '$1').replace(NUMBER, '$1');
}

function prefixLines(text: string, sel: Selection, command: 'h2' | 'h3' | 'bullets' | 'numbers' | 'quote'): Edit {
  const range = lineRange(text, sel);
  const lines = text.slice(range.start, range.end).split('\n');
  const marker = { h2: '## ', h3: '### ', quote: '> ' } as const;
  const has = (line: string) => {
    switch (command) {
      case 'h2':
        return /^##\s+/.test(line) && !/^###/.test(line);
      case 'h3':
        return /^###\s+/.test(line) && !/^####/.test(line);
      case 'bullets':
        return BULLET.test(line);
      case 'numbers':
        return NUMBER.test(line);
      case 'quote':
        return QUOTE.test(line);
    }
  };
  const content = lines.filter((l) => l.trim());
  // Pressing the button again on lines that already have the format removes it, as in word processors.
  const removing = content.length > 0 && content.every(has);
  let n = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    const bare = strip(line);
    if (removing) return bare;
    if (command === 'bullets') return `- ${bare.trimStart()}`;
    if (command === 'numbers') return `${++n}. ${bare.trimStart()}`;
    return `${marker[command]}${bare.trimStart()}`;
  });
  const insert = out.join('\n');
  return { from: range.start, to: range.end, insert, select: { start: range.start, end: range.start + insert.length } };
}

function wrap(text: string, sel: Selection, mark: string, placeholder: string): Edit {
  const selected = text.slice(sel.start, sel.end);
  const before = text.slice(Math.max(0, sel.start - mark.length), sel.start);
  const after = text.slice(sel.end, sel.end + mark.length);
  // Already wrapped: unwrap.
  if (selected && before === mark && after === mark) {
    return { from: sel.start - mark.length, to: sel.end + mark.length, insert: selected, select: { start: sel.start - mark.length, end: sel.end - mark.length } };
  }
  if (selected.length > 2 * mark.length && selected.startsWith(mark) && selected.endsWith(mark)) {
    const inner = selected.slice(mark.length, -mark.length);
    return { from: sel.start, to: sel.end, insert: inner, select: { start: sel.start, end: sel.start + inner.length } };
  }
  // Spaces stay outside the marks, because "** word**" is not bold in Markdown.
  const lead = selected.match(/^\s*/)![0];
  const trail = selected.slice(lead.length).match(/\s*$/)![0];
  const core = selected.slice(lead.length, selected.length - trail.length) || placeholder;
  const insert = `${lead}${mark}${core}${mark}${trail}`;
  const start = sel.start + lead.length + mark.length;
  return { from: sel.start, to: sel.end, insert, select: { start, end: start + core.length } };
}

function block(text: string, sel: Selection, content: string, selectFrom: number, selectLength: number): Edit {
  const before = text.slice(0, sel.start);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const rest = text.slice(sel.end);
  const tail = rest === '' || rest.startsWith('\n\n') ? '' : rest.startsWith('\n') ? '\n' : '\n\n';
  const insert = `${lead}${content}${tail}`;
  const start = sel.start + lead.length + selectFrom;
  return { from: sel.start, to: sel.end, insert, select: { start, end: start + selectLength } };
}

export function applyCommand(text: string, sel: Selection, command: EditCommand): Edit {
  switch (command) {
    case 'bold':
      return wrap(text, sel, '**', 'bold text');
    case 'italic':
      return wrap(text, sel, '*', 'italic text');
    case 'table':
      return block(text, sel, '| Column | Column |\n| --- | --- |\n| Text | Text |', 2, 6);
    case 'rule':
      return block(text, sel, '---', 3, 0);
    default:
      return prefixLines(text, sel, command);
  }
}

/** The heading anchor (as in the rendered page) of the section the cursor is in, so the preview can follow. */
export function headingAnchorAt(text: string, position: number): string | null {
  // Only whole lines before the cursor: the blocks they make are numbered exactly as in the full text.
  const blocks = parseMarkdown(text.slice(0, text.lastIndexOf('\n', position - 1) + 1));
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.type === 'heading') return `h${i}`;
  return null;
}
