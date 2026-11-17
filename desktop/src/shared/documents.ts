import { formatDuration } from './format';
import { parseMarkdown, type Block, type Inline } from './markdown';
import type { SummaryLength, SummaryTone } from './summaries';
import type { Segment } from './transcript';

/**
 * Documents are editable Markdown plus layout settings. One renderer turns them into the HTML used for
 * the preview, the PDF and the HTML export, so what you see is what you get. Nothing here touches the
 * network, the disk or Electron.
 */

export const PAGE_SIZES = { A4: 'A4', Letter: 'Letter', Legal: 'Legal' } as const;
export type PageSize = keyof typeof PAGE_SIZES;

/** Width and height in millimetres. */
export const PAGE_MM: Record<PageSize, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };

export const MARGINS = { narrow: 'Narrow', normal: 'Normal', wide: 'Wide' } as const;
export type Margins = keyof typeof MARGINS;
export const MARGIN_MM: Record<Margins, number> = { narrow: 12, normal: 20, wide: 28 };

export const ACCENTS = { indigo: '#4338ca', teal: '#0f766e', ember: '#c2410c', slate: '#334155', crimson: '#be123c' } as const;
export type Accent = keyof typeof ACCENTS;

export interface DocumentSettings {
  subtitle: string;
  author: string;
  date: string;
  pageSize: PageSize;
  margins: Margins;
  font: 'sans' | 'serif';
  urduStyle: 'nastaliq' | 'naskh';
  /** Points. */
  fontSize: number;
  lineSpacing: number;
  paragraphSpacing: 'compact' | 'normal' | 'relaxed';
  headingStyle: 'modern' | 'classic' | 'minimal';
  bulletStyle: 'disc' | 'dash' | 'arrow';
  numberStyle: 'decimal' | 'roman' | 'alpha';
  accent: Accent;
  coverPage: boolean;
  toc: boolean;
  pageNumbers: boolean;
  header: string;
  footer: string;
  /** Show times next to claims, such as [3:05]. */
  timestamps: boolean;
  /** A note naming the recording the content came from. */
  sources: boolean;
  /** Append the full transcript. */
  transcript: boolean;
  transcriptTimestamps: boolean;
  speakerLabels: boolean;
  direction: 'auto' | 'ltr' | 'rtl';
  /** BCP 47 code for the document, such as en or ur. Empty means not set. */
  language: string;
}

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  subtitle: '',
  author: '',
  date: '',
  pageSize: 'A4',
  margins: 'normal',
  font: 'sans',
  urduStyle: 'nastaliq',
  fontSize: 11,
  lineSpacing: 1.5,
  paragraphSpacing: 'normal',
  headingStyle: 'modern',
  bulletStyle: 'disc',
  numberStyle: 'decimal',
  accent: 'indigo',
  coverPage: true,
  toc: false,
  pageNumbers: true,
  header: '',
  footer: '',
  timestamps: true,
  sources: true,
  transcript: false,
  transcriptTimestamps: true,
  speakerLabels: true,
  direction: 'auto',
  language: '',
};

export type DocumentSource = 'ai' | 'transcript' | 'summary' | 'blank';

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string;
  /** How new documents from this template get their first draft. */
  source: 'ai' | 'transcript' | 'blank';
  length: SummaryLength;
  tone: SummaryTone;
  instructions: string;
  settings: Partial<DocumentSettings>;
}

/** The nine templates from prompt §11. */
export const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    id: 'academic-notes',
    name: 'Academic Notes',
    description: 'Concepts, definitions, explanations and examples, organized by topic.',
    source: 'ai',
    length: 'detailed',
    tone: 'academic',
    instructions: 'Write academic notes. Use a heading for each topic. Under each, give the key concept, precise definitions in bold, the explanation given, and the examples used. End with a "Key takeaways" list.',
    settings: { font: 'serif', headingStyle: 'classic', toc: true },
  },
  {
    id: 'lecture-report',
    name: 'Detailed Lecture Report',
    description: 'A thorough report of the whole lecture, section by section.',
    source: 'ai',
    length: 'comprehensive',
    tone: 'academic',
    instructions: 'Write a detailed lecture report with these sections: Overview, then one section per topic in the order taught (with explanations, examples, formulas and questions raised), Important concepts, Possible exam topics, and Revision notes.',
    settings: { font: 'serif', headingStyle: 'classic', toc: true },
  },
  {
    id: 'meeting-minutes',
    name: 'Meeting Minutes',
    description: 'Formal minutes: agenda, discussion, decisions and action items.',
    source: 'ai',
    length: 'detailed',
    tone: 'formal',
    instructions: 'Write formal meeting minutes with these sections: Meeting details (purpose, and participants only if identifiable), Agenda, Discussion, Decisions, Action items as a table with the columns Action, Owner, Deadline, and Next steps. Use "Not stated" when an owner or deadline was not mentioned.',
    settings: { accent: 'slate', headingStyle: 'modern' },
  },
  {
    id: 'business-report',
    name: 'Business Report',
    description: 'Requirements, decisions, commitments and follow-ups for clients and teams.',
    source: 'ai',
    length: 'detailed',
    tone: 'professional',
    instructions: 'Write a business report with these sections: Summary, Background, Requirements, Decisions, Commitments, Risks or open questions, and Follow-up actions.',
    settings: { accent: 'teal' },
  },
  {
    id: 'interview-transcript',
    name: 'Interview Transcript',
    description: 'The full transcript with speakers and times. No AI needed.',
    source: 'transcript',
    length: 'comprehensive',
    tone: 'formal',
    instructions: '',
    settings: { accent: 'ember', timestamps: true },
  },
  {
    id: 'study-guide',
    name: 'Study Guide',
    description: 'What to learn, key terms, and questions to test yourself.',
    source: 'ai',
    length: 'detailed',
    tone: 'beginner',
    instructions: 'Write a study guide with these sections: Learning goals, Key terms (a table with Term and Meaning), Main ideas explained simply, Worked examples from the recording, Common mistakes if mentioned, and Self-test questions with short answers.',
    settings: { accent: 'teal', toc: true },
  },
  {
    id: 'executive-summary',
    name: 'Executive Summary',
    description: 'The bottom line first, in one or two pages.',
    source: 'ai',
    length: 'short',
    tone: 'professional',
    instructions: 'Write an executive summary: start with the bottom line in two or three sentences, then Key points, Decisions and implications, and Recommended next steps.',
    settings: { coverPage: false, accent: 'slate' },
  },
  {
    id: 'research-notes',
    name: 'Research Notes',
    description: 'Findings, evidence, quotes and open questions.',
    source: 'ai',
    length: 'detailed',
    tone: 'academic',
    instructions: 'Write research notes with these sections: Research question or theme, Findings (each with its evidence), Notable quotes with their speaker when known, Methods or sources mentioned, Open questions, and Ideas for follow-up.',
    settings: { font: 'serif', headingStyle: 'minimal' },
  },
  {
    id: 'custom',
    name: 'Custom Document',
    description: 'Your own instructions, or start from a blank page.',
    source: 'ai',
    length: 'detailed',
    tone: 'professional',
    instructions: 'Follow the custom instructions closely.',
    settings: {},
  },
];

export function templateById(id: string): DocumentTemplate {
  return DOCUMENT_TEMPLATES.find((t) => t.id === id) ?? DOCUMENT_TEMPLATES[DOCUMENT_TEMPLATES.length - 1]!;
}

// Text direction

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

const STRONG_CHAR = new RegExp(`${LTR_CHAR.source.slice(0, -1)}${RTL_CHAR.source.slice(1)}`);
const IS_RTL_CHAR = new RegExp(RTL_CHAR.source);

/**
 * Direction of one piece of text, decided by its first letter that has a direction (the Unicode bidi
 * rule browsers use for dir="auto"). "یہ اردو ہے with English" is right-to-left; "Notes on لفظ" is not.
 */
export function isRtlText(text: string): boolean {
  const first = STRONG_CHAR.exec(text);
  return first !== null && IS_RTL_CHAR.test(first[0]);
}

/**
 * Direction of a whole document: whichever script most of the body is written in. The title is left
 * out, because an English title on Urdu notes (or the reverse) is common and should not flip the page.
 */
export function documentDirection(settings: DocumentSettings, body: string, title = ''): 'ltr' | 'rtl' {
  if (settings.direction !== 'auto') return settings.direction;
  const text = (body.trim() ? body : title).replace(/\]\(cite:\d+\)/g, ']');
  const rtl = text.match(RTL_CHAR)?.length ?? 0;
  const ltr = text.match(LTR_CHAR)?.length ?? 0;
  return rtl > 0 && rtl >= ltr ? 'rtl' : 'ltr';
}

// Shared input for every format

export interface DocumentInput {
  title: string;
  markdown: string;
  settings: DocumentSettings;
  source: { title: string; createdAt: number; durationMs: number } | null;
  transcript: { segments: Segment[]; speakers: Record<string, string> } | null;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Citations are links in the editor. In documents they become plain times, or disappear if turned off. */
export function inlineText(nodes: Inline[], timestamps: boolean): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.text;
        case 'code':
          return n.text;
        case 'bold':
        case 'italic':
          return inlineText(n.children, timestamps);
        case 'cite':
          return timestamps ? `[${n.label}]` : CITE_GAP;
      }
    })
    .join('')
    .replace(CITE_GAP_WITH_SPACE, '');
}

// A hidden time takes the space before it along, and nothing else about the text changes.
const CITE_GAP = '\u0000';
const CITE_GAP_WITH_SPACE = / ?\u0000/g;

function inlineHtml(nodes: Inline[], timestamps: boolean): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return escapeHtml(n.text);
        case 'code':
          return `<code>${escapeHtml(n.text)}</code>`;
        case 'bold':
          return `<strong>${inlineHtml(n.children, timestamps)}</strong>`;
        case 'italic':
          return `<em>${inlineHtml(n.children, timestamps)}</em>`;
        case 'cite':
          return timestamps ? `<span class="cite">${escapeHtml(n.label)}</span>` : '';
      }
    })
    .join('');
}

export interface Heading {
  level: number;
  text: string;
  anchor: string;
}

export function documentHeadings(blocks: Block[], timestamps = false): Heading[] {
  return blocks.flatMap((b, i) => (b.type === 'heading' && b.level <= 2 ? [{ level: b.level, text: inlineText(b.children, timestamps), anchor: `h${i}` }] : []));
}

function speakerName(label: string | null, names: Record<string, string>): string | null {
  return label ? (names[label] ?? `Speaker ${label}`) : null;
}

function blocksHtml(blocks: Block[], timestamps: boolean): string {
  return blocks
    .map((b, i) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level} id="h${i}" dir="auto">${inlineHtml(b.children, timestamps)}</h${b.level}>`;
        case 'paragraph':
          return `<p dir="auto">${inlineHtml(b.children, timestamps)}</p>`;
        case 'quote':
          return `<blockquote dir="auto">${inlineHtml(b.children, timestamps)}</blockquote>`;
        case 'rule':
          return '<hr>';
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          const items = b.items.map((item) => `<li dir="auto" class="depth-${item.depth}">${inlineHtml(item.children, timestamps)}</li>`).join('');
          return `<${tag}>${items}</${tag}>`;
        }
        case 'table': {
          const head = b.header.map((c) => `<th dir="auto">${inlineHtml(c, timestamps)}</th>`).join('');
          const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td dir="auto">${inlineHtml(c, timestamps)}</td>`).join('')}</tr>`).join('');
          return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
        }
      }
    })
    .join('\n');
}

const BULLETS: Record<DocumentSettings['bulletStyle'], string> = { disc: 'disc', dash: '"– "', arrow: '"→ "' };
const NUMBERS: Record<DocumentSettings['numberStyle'], string> = { decimal: 'decimal', roman: 'lower-roman', alpha: 'lower-alpha' };
const SPACING: Record<DocumentSettings['paragraphSpacing'], number> = { compact: 0.4, normal: 0.75, relaxed: 1.1 };

function styles(s: DocumentSettings, dir: 'ltr' | 'rtl'): string {
  const [w, h] = PAGE_MM[s.pageSize];
  const m = MARGIN_MM[s.margins];
  const accent = ACCENTS[s.accent];
  const urdu = s.urduStyle === 'nastaliq' ? "'Noto Nastaliq Urdu'" : "'Noto Naskh Arabic'";
  // The embedded faces come first: Urdu must reach Nastaliq or Naskh before any system font, because
  // Segoe UI also has Arabic letters and would win. Each embedded face only covers its own script, so the
  // order never changes English text. System fonts stay last, for scripts not embedded.
  const fonts = s.font === 'serif' ? `'Noto Serif', ${urdu}, Georgia, 'Segoe UI', serif` : `'Inter Variable', ${urdu}, 'Segoe UI', sans-serif`;
  const heading =
    s.headingStyle === 'classic'
      ? `h1,h2,h3{color:#111;font-family:'Noto Serif', ${urdu}, Georgia, serif} h2{border-bottom:1px solid #bbb;padding-bottom:.2em}`
      : s.headingStyle === 'minimal'
        ? `h1,h2,h3{color:#222;font-weight:600} h2{text-transform:uppercase;letter-spacing:.08em;font-size:1em}`
        : `h1,h2{color:${accent}} h3{color:#222}`;
  // Nastaliq is tall; Arabic-script blocks get extra line height so lines never collide.
  const tall = s.urduStyle === 'nastaliq' ? Math.max(s.lineSpacing, 2.2) : Math.max(s.lineSpacing, 1.8);
  return `
@page { size: ${w}mm ${h}mm; }
* { box-sizing: border-box; }
html { background: #e9e8e4; }
body { margin: 0; padding: 24px 0; font-family: ${fonts}; font-size: ${s.fontSize}pt; line-height: ${s.lineSpacing}; color: #1c1b18; }
.sheet { width: ${w}mm; min-height: ${h}mm; margin: 0 auto 24px; padding: ${m}mm; background: #fff; box-shadow: 0 2px 10px rgb(0 0 0 / 12%); }
.running { font-size: 8pt; color: #777; }
.running.top { margin: -${m * 0.6}mm 0 ${m * 0.4}mm; }
.running.bottom { margin-top: ${m * 0.4}mm; border-top: 1px solid #eee; padding-top: 4px; }
p, ul, ol, table, blockquote { margin: 0 0 ${SPACING[s.paragraphSpacing]}em; }
h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 .5em; }
h2 { font-size: 1.4em; line-height: 1.25; margin: 1.2em 0 .5em; }
h3 { font-size: 1.12em; line-height: 1.3; margin: 1em 0 .4em; }
${heading}
ul { list-style: ${BULLETS[s.bulletStyle]}; }
ol { list-style: ${NUMBERS[s.numberStyle]}; }
ul, ol { padding-inline-start: 1.4em; }
li { margin: .2em 0; }
li.depth-1 { margin-inline-start: 1.2em; } li.depth-2 { margin-inline-start: 2.4em; } li.depth-3 { margin-inline-start: 3.6em; }
table { width: 100%; border-collapse: collapse; font-size: .92em; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 1px solid #cfccc3; padding: 5px 8px; text-align: start; vertical-align: top; }
th { background: ${accent}14; font-weight: 600; }
blockquote { border-inline-start: 3px solid ${accent}; padding-inline-start: 12px; color: #444; font-style: italic; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1.2em 0; }
code { font-family: Consolas, monospace; font-size: .9em; background: #f3f2ee; padding: 0 3px; border-radius: 3px; }
.cite { font-size: .78em; color: ${accent}; white-space: nowrap; }
h1, h2, h3 { break-after: avoid; }
[dir=rtl], .rtl p, .rtl li, .rtl td, .rtl th { line-height: ${tall}; }
:is(p, li, td, th, h1, h2, h3, blockquote):dir(rtl) { line-height: ${tall}; }
.cover { display: flex; flex-direction: column; justify-content: center; }
.cover .rule { width: 64px; height: 6px; background: ${accent}; border-radius: 3px; margin-bottom: 28px; }
.cover h1 { font-size: 2.6em; color: #111; }
.cover .subtitle { font-size: 1.3em; color: #555; margin-bottom: 2.5em; }
.cover .meta { color: #555; font-size: .95em; line-height: 1.7; }
.toc h2 { margin-top: 0; }
.toc ol { list-style: none; padding: 0; }
.toc li { margin: .35em 0; }
.toc li.l2 { padding-inline-start: 1.4em; color: #444; }
.toc a { color: inherit; text-decoration: none; }
.source { font-size: .85em; color: #666; border-top: 1px solid #eee; padding-top: .6em; margin-top: 2em; }
.transcript p { margin-bottom: .45em; }
.transcript .ts { color: ${accent}; font-size: .82em; margin-inline-end: .4em; white-space: nowrap; }
.transcript .who { font-weight: 600; }
.transcript-title { break-before: page; }
@media print {
  html { background: none; }
  body { padding: 0; }
  .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  .sheet + .sheet { break-before: page; }
  .running { display: none; }
}
${dir === 'rtl' ? '.content { text-align: start; }' : ''}
`;
}

function transcriptHtml(transcript: NonNullable<DocumentInput['transcript']>, s: DocumentSettings): string {
  const lines = transcript.segments
    .map((seg) => {
      const time = s.transcriptTimestamps ? `<span class="ts">[${formatDuration(seg.startMs)}]</span>` : '';
      const who = s.speakerLabels ? speakerName(seg.speaker, transcript.speakers) : null;
      return `<p dir="auto">${time}${who ? `<span class="who">${escapeHtml(who)}:</span> ` : ''}${escapeHtml(seg.text)}</p>`;
    })
    .join('\n');
  return `<h2 class="transcript-title">Transcript</h2><div class="transcript">${lines}</div>`;
}

export function sourceNote(input: DocumentInput): string | null {
  if (!input.settings.sources || !input.source) return null;
  const when = new Date(input.source.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' });
  const times = input.settings.timestamps ? ' Times in brackets point to moments in that recording.' : '';
  return `Source: “${input.source.title}”, recorded ${when}, ${formatDuration(input.source.durationMs)} long.${times} Generated content can contain mistakes, so check important details against the recording.`;
}

/**
 * The complete, self-contained page. Every piece of text is escaped, and there is no script anywhere,
 * so the output is safe to show and to share.
 */
export function documentToHtml(input: DocumentInput, fontCss: string): string {
  const s = input.settings;
  const blocks = parseMarkdown(input.markdown);
  const dir = documentDirection(s, input.markdown, input.title);
  const lang = s.language ? ` lang="${escapeHtml(s.language)}"` : '';
  const running = (where: 'top' | 'bottom', text: string) => (text ? `<div class="running ${where}" dir="auto">${escapeHtml(text)}</div>` : '');
  const sheets: string[] = [];

  if (s.coverPage) {
    const meta = [s.author, s.date].filter(Boolean).map((x) => `<div dir="auto">${escapeHtml(x)}</div>`).join('');
    sheets.push(
      `<section class="sheet cover"><div class="rule"></div><h1 dir="auto">${escapeHtml(input.title)}</h1>${s.subtitle ? `<div class="subtitle" dir="auto">${escapeHtml(s.subtitle)}</div>` : ''}<div class="meta">${meta}</div></section>`,
    );
  }

  const headings = documentHeadings(blocks);
  const toc =
    s.toc && headings.length
      ? `<nav class="toc"><h2>Contents</h2><ol>${headings.map((h) => `<li class="l${h.level}" dir="auto"><a href="#${h.anchor}">${escapeHtml(h.text)}</a></li>`).join('')}</ol></nav>`
      : '';
  if (toc && s.coverPage) sheets.push(`<section class="sheet">${toc}</section>`);

  const titleBlock = s.coverPage ? '' : `<h1 dir="auto">${escapeHtml(input.title)}</h1>${s.subtitle ? `<p class="subtitle" dir="auto">${escapeHtml(s.subtitle)}</p>` : ''}`;
  const note = sourceNote(input);
  const body = [
    titleBlock,
    toc && !s.coverPage ? toc : '',
    blocksHtml(blocks, s.timestamps),
    note ? `<p class="source" dir="auto">${escapeHtml(note)}</p>` : '',
    s.transcript && input.transcript ? transcriptHtml(input.transcript, s) : '',
  ].join('\n');
  sheets.push(`<section class="sheet content${dir === 'rtl' ? ' rtl' : ''}">${running('top', s.header)}${body}${running('bottom', s.footer)}</section>`);

  return `<!doctype html><html dir="${dir}"${lang}><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>${fontCss}\n${styles(s, dir)}</style></head><body>${sheets.join('\n')}</body></html>`;
}

/** Markdown export: citations become readable times, and the title becomes the first heading. */
export function documentToMarkdown(input: DocumentInput): string {
  const body = input.settings.timestamps ? input.markdown.replace(/\[([^\]]+)\]\(cite:\d+\)/g, '[$1]') : input.markdown.replace(/ ?\[[^\]]+\]\(cite:\d+\)/g, '');
  const note = sourceNote(input);
  return `# ${input.title}\n\n${input.settings.subtitle ? `${input.settings.subtitle}\n\n` : ''}${body.trim()}\n${note ? `\n---\n\n${note}\n` : ''}`;
}

export function documentToText(input: DocumentInput): string {
  const t = input.settings.timestamps;
  const out: string[] = [input.title.toUpperCase(), ''];
  if (input.settings.subtitle) out.push(input.settings.subtitle, '');
  for (const b of parseMarkdown(input.markdown)) {
    switch (b.type) {
      case 'heading': {
        const text = inlineText(b.children, t);
        out.push(text, (b.level <= 2 ? '=' : '-').repeat(Math.min(60, text.length)), '');
        break;
      }
      case 'paragraph':
      case 'quote':
        out.push(inlineText(b.children, t), '');
        break;
      case 'list':
        b.items.forEach((item, i) => out.push(`${'  '.repeat(item.depth)}${b.ordered ? `${i + 1}.` : '•'} ${inlineText(item.children, t)}`));
        out.push('');
        break;
      case 'table':
        out.push(b.header.map((c) => inlineText(c, t)).join(' | '));
        for (const row of b.rows) out.push(row.map((c) => inlineText(c, t)).join(' | '));
        out.push('');
        break;
      case 'rule':
        out.push('—'.repeat(20), '');
        break;
    }
  }
  const note = sourceNote(input);
  if (note) out.push(note);
  return `${out.join('\n').trim()}\n`;
}

/** Cells starting with these could run as formulas when opened in a spreadsheet. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}

export function transcriptToCsv(segments: Segment[], speakers: Record<string, string> = {}): string {
  const rows = [['Start', 'End', 'Speaker', 'Text'], ...segments.map((s) => [csvTime(s.startMs), csvTime(s.endMs), speakerName(s.speaker, speakers) ?? '', s.text])];
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** A transcript turned into Markdown, for the Interview Transcript template. No AI involved. */
export function transcriptToMarkdown(segments: Segment[], speakers: Record<string, string>): string {
  const turns: { speaker: string | null; startMs: number; text: string[] }[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) last.text.push(`${s.text} [${formatDuration(s.startMs)}](cite:${s.startMs})`);
    else turns.push({ speaker: s.speaker, startMs: s.startMs, text: [`${s.text} [${formatDuration(s.startMs)}](cite:${s.startMs})`] });
  }
  const body = turns.map((t) => {
    const who = speakerName(t.speaker, speakers);
    return `${who ? `**${who}:** ` : ''}${t.text.join(' ')}`;
  });
  return `## Transcript\n\n${body.join('\n\n')}\n`;
}

// Slides

export interface Slide {
  title: string;
  bullets: { text: string; depth: number; strong: boolean }[];
  table: { header: string[]; rows: string[][] } | null;
}

const MAX_BULLETS = 7;
const MAX_TABLE_ROWS = 9;
const MAX_BULLET_CHARS = 220;

function shorten(text: string): string {
  return text.length > MAX_BULLET_CHARS ? `${text.slice(0, MAX_BULLET_CHARS - 1).trimEnd()}…` : text;
}

/**
 * Turns a document into slides: one per section, continued when there is too much for one slide, with
 * tables on their own slides. Long paragraphs are shortened, because slides are not documents.
 */
export function planSlides(markdown: string, timestamps: boolean, fallbackTitle: string): Slide[] {
  const slides: Slide[] = [];
  const state: { current: Slide | null } = { current: null };
  const open = (title: string): Slide => {
    const slide: Slide = { title, bullets: [], table: null };
    slides.push(slide);
    state.current = slide;
    return slide;
  };
  const baseTitle = () => (state.current ? state.current.title.replace(/ \(continued\)$/, '') : fallbackTitle);
  const add = (text: string, depth: number, strong = false) => {
    if (!text.trim()) return;
    let slide = state.current ?? open(fallbackTitle);
    if (slide.bullets.length >= MAX_BULLETS || slide.table) slide = open(`${baseTitle()} (continued)`);
    slide.bullets.push({ text: shorten(text), depth, strong });
  };

  for (const b of parseMarkdown(markdown)) {
    switch (b.type) {
      case 'heading':
        if (b.level <= 2) open(inlineText(b.children, false));
        else add(inlineText(b.children, false), 0, true);
        break;
      case 'paragraph':
      case 'quote':
        add(inlineText(b.children, timestamps), 0);
        break;
      case 'list':
        for (const item of b.items) add(inlineText(item.children, timestamps), Math.min(item.depth, 2));
        break;
      case 'table': {
        const header = b.header.map((c) => inlineText(c, timestamps));
        const rows = b.rows.map((r) => r.map((c) => inlineText(c, timestamps)));
        const title = baseTitle();
        for (let i = 0; i < Math.max(1, rows.length); i += MAX_TABLE_ROWS) {
          // A table goes on an empty slide when there is one, otherwise on a slide of its own.
          const empty = state.current && state.current.bullets.length === 0 && !state.current.table;
          const slide = empty ? state.current! : open(state.current || i > 0 ? `${title} (continued)` : title);
          slide.table = { header, rows: rows.slice(i, i + MAX_TABLE_ROWS) };
        }
        break;
      }
      case 'rule':
        break;
    }
  }
  return slides.filter((s) => s.bullets.length || s.table);
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (cleaned || 'Document').slice(0, 120);
}

export const EXPORT_FORMATS = {
  pdf: { label: 'PDF', extension: 'pdf', mime: 'application/pdf' },
  docx: { label: 'Word (DOCX)', extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { label: 'PowerPoint (PPTX)', extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  html: { label: 'Web page (HTML)', extension: 'html', mime: 'text/html' },
  md: { label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  txt: { label: 'Plain text', extension: 'txt', mime: 'text/plain' },
} as const;
export type ExportFormat = keyof typeof EXPORT_FORMATS;
