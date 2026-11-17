import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
} from 'docx';
import { ACCENTS, documentDirection, isRtlText, MARGIN_MM, PAGE_MM, sourceNote, type DocumentInput, type DocumentSettings } from '@shared/documents';
import { formatDuration } from '@shared/format';
import { parseMarkdown, type Inline } from '@shared/markdown';

const TWIPS_PER_MM = 56.693;

/** Word substitutes fonts it lacks, so these are names Windows and Office normally have. */
function fonts(s: DocumentSettings) {
  return { latin: s.font === 'serif' ? 'Cambria' : 'Calibri', complex: s.urduStyle === 'nastaliq' ? 'Noto Nastaliq Urdu' : 'Noto Naskh Arabic' };
}

const SPACING_AFTER: Record<DocumentSettings['paragraphSpacing'], number> = { compact: 80, normal: 160, relaxed: 240 };
const NUMBER_FORMAT: Record<DocumentSettings['numberStyle'], (typeof LevelFormat)[keyof typeof LevelFormat]> = { decimal: LevelFormat.DECIMAL, roman: LevelFormat.LOWER_ROMAN, alpha: LevelFormat.LOWER_LETTER };
const BULLET_TEXT: Record<DocumentSettings['bulletStyle'], string> = { disc: '•', dash: '–', arrow: '→' };

/** Builds a real Word document, not text under a .docx name, from the same content as the PDF. */
export async function buildDocx(input: DocumentInput): Promise<Buffer> {
  const s = input.settings;
  const font = fonts(s);
  const accent = ACCENTS[s.accent].slice(1);
  const docRtl = documentDirection(s, input.markdown) === 'rtl';

  const rtlFor = (text: string) => (s.direction === 'auto' ? isRtlText(text) : s.direction === 'rtl');
  const base = (rtl: boolean): IRunOptions => ({ font: { ascii: font.latin, hAnsi: font.latin, cs: font.complex, eastAsia: font.latin }, size: s.fontSize * 2, sizeComplexScript: s.fontSize * 2, rightToLeft: rtl });

  const runs = (nodes: Inline[], rtl: boolean, style: Partial<IRunOptions> = {}): TextRun[] =>
    nodes.flatMap((n): TextRun[] => {
      switch (n.type) {
        case 'text':
          return n.text ? [new TextRun({ ...base(rtl), ...style, text: n.text })] : [];
        case 'code':
          return [new TextRun({ ...base(rtl), ...style, text: n.text, font: 'Consolas' })];
        case 'bold':
          return runs(n.children, rtl, { ...style, bold: true, boldComplexScript: true });
        case 'italic':
          return runs(n.children, rtl, { ...style, italics: true, italicsComplexScript: true });
        case 'cite':
          return s.timestamps ? [new TextRun({ ...base(rtl), ...style, text: ` [${n.label}]`, color: accent, size: Math.round(s.fontSize * 1.6) })] : [];
      }
    });

  const plain = (nodes: Inline[]): string => nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : n.type === 'cite' ? '' : plain(n.children))).join('');
  const lineSpacing = Math.round(240 * s.lineSpacing);
  const paragraph = (nodes: Inline[], extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {}) => {
    const rtl = rtlFor(plain(nodes));
    return new Paragraph({ children: runs(nodes, rtl), bidirectional: rtl, spacing: { after: SPACING_AFTER[s.paragraphSpacing], line: lineSpacing }, ...extra });
  };

  const children: (Paragraph | Table | TableOfContents)[] = [];

  if (s.coverPage) {
    const rtl = rtlFor(input.title);
    children.push(new Paragraph({ children: [], spacing: { before: 2400 } }));
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, bidirectional: rtl, children: [new TextRun({ ...base(rtl), text: input.title, size: 56, bold: true })] }));
    if (s.subtitle) children.push(new Paragraph({ bidirectional: rtlFor(s.subtitle), spacing: { after: 600 }, children: [new TextRun({ ...base(rtlFor(s.subtitle)), text: s.subtitle, size: 30, color: '555555' })] }));
    for (const line of [s.author, s.date].filter(Boolean)) children.push(new Paragraph({ bidirectional: rtlFor(line), children: [new TextRun({ ...base(rtlFor(line)), text: line, color: '555555' })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  } else {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, bidirectional: rtlFor(input.title), children: [new TextRun({ ...base(rtlFor(input.title)), text: input.title, size: 44, bold: true })] }));
  }

  if (s.toc) {
    // A real Word table of contents. Word fills in page numbers when it updates fields on opening.
    children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
    if (s.coverPage) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  for (const block of parseMarkdown(input.markdown)) {
    switch (block.type) {
      case 'heading':
        children.push(paragraph(block.children, { heading: HEADINGS[block.level - 1] }));
        break;
      case 'paragraph':
        children.push(paragraph(block.children));
        break;
      case 'quote':
        children.push(paragraph(block.children, { indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 8 } } }));
        break;
      case 'rule':
        children.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDDDDD', space: 4 } } }));
        break;
      case 'list':
        for (const item of block.items) {
          children.push(paragraph(item.children, { numbering: { reference: block.ordered ? 'numbers' : 'bullets', level: item.depth } }));
        }
        break;
      case 'table': {
        const cell = (nodes: Inline[], header: boolean) =>
          new TableCell({
            children: [paragraph(header ? [{ type: 'bold', children: nodes }] : nodes, { spacing: { after: 0 } })],
            shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF0FA' } : undefined,
          });
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            visuallyRightToLeft: docRtl,
            rows: [new TableRow({ tableHeader: true, children: block.header.map((c) => cell(c, true)) }), ...block.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
          }),
        );
        children.push(new Paragraph({ children: [] }));
        break;
      }
    }
  }

  const note = sourceNote(input);
  if (note) children.push(new Paragraph({ bidirectional: rtlFor(note), spacing: { before: 480 }, children: [new TextRun({ ...base(rtlFor(note)), text: note, size: Math.round(s.fontSize * 1.7), color: '666666' })] }));

  if (s.transcript && input.transcript) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ ...base(false), text: 'Transcript' })] }));
    for (const seg of input.transcript.segments) {
      const rtl = rtlFor(seg.text);
      const who = s.speakerLabels && seg.speaker ? (input.transcript.speakers[seg.speaker] ?? `Speaker ${seg.speaker}`) : null;
      children.push(
        new Paragraph({
          bidirectional: rtl,
          spacing: { after: 80, line: lineSpacing },
          children: [
            ...(s.transcriptTimestamps ? [new TextRun({ ...base(rtl), text: `[${formatDuration(seg.startMs)}] `, color: accent, size: Math.round(s.fontSize * 1.6) })] : []),
            ...(who ? [new TextRun({ ...base(rtl), text: `${who}: `, bold: true })] : []),
            new TextRun({ ...base(rtl), text: seg.text }),
          ],
        }),
      );
    }
  }

  const [w, h] = PAGE_MM[s.pageSize];
  const margin = Math.round(MARGIN_MM[s.margins] * TWIPS_PER_MM);
  const level = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
    [0, 1, 2, 3].map((i) => ({ level: i, format, text: text(i), alignment: AlignmentType.START, style: { paragraph: { indent: { left: 567 * (i + 1), hanging: 283 } } } }));

  const doc = new Document({
    creator: s.author || 'EchoMind',
    title: input.title,
    description: s.subtitle || undefined,
    features: { updateFields: s.toc },
    styles: {
      default: { document: { run: { font: { ascii: font.latin, hAnsi: font.latin, cs: font.complex }, size: s.fontSize * 2 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: Math.round(s.fontSize * 3.4), bold: true, color: s.headingStyle === 'modern' ? accent : '111111' }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: Math.round(s.fontSize * 2.7), bold: true, color: s.headingStyle === 'modern' ? accent : '111111' }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: Math.round(s.fontSize * 2.3), bold: true, color: '222222' }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: level(LevelFormat.BULLET, () => BULLET_TEXT[s.bulletStyle]) },
        { reference: 'numbers', levels: level(NUMBER_FORMAT[s.numberStyle], (i) => `%${i + 1}.`) },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: Math.round(w * TWIPS_PER_MM), height: Math.round(h * TWIPS_PER_MM) }, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
        headers: s.header ? { default: new Header({ children: [new Paragraph({ bidirectional: rtlFor(s.header), children: [new TextRun({ ...base(rtlFor(s.header)), text: s.header, size: 16, color: '777777' })] })] }) } : undefined,
        footers:
          s.footer || s.pageNumbers
            ? {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({ ...base(false), text: s.footer ? `${s.footer}${s.pageNumbers ? '    ' : ''}` : '', size: 16, color: '777777' }),
                        ...(s.pageNumbers ? [new TextRun({ ...base(false), children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '777777' })] : []),
                      ],
                    }),
                  ],
                }),
              }
            : undefined,
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
