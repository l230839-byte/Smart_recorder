import PptxGenJS from 'pptxgenjs';
import { ACCENTS, documentDirection, isRtlText, planSlides, sourceNote, type DocumentInput } from '@shared/documents';

/** Builds real slides from the document: a title slide, then one slide per section. */
export async function buildPptx(input: DocumentInput): Promise<Buffer> {
  const s = input.settings;
  const accent = ACCENTS[s.accent].slice(1);
  const latin = s.font === 'serif' ? 'Cambria' : 'Calibri';
  const complex = s.urduStyle === 'nastaliq' ? 'Noto Nastaliq Urdu' : 'Noto Naskh Arabic';
  const rtlDoc = documentDirection(s, input.markdown) === 'rtl';
  const face = (text: string) => (isRtlText(text) ? complex : latin);
  const textOptions = (text: string) => ({ fontFace: face(text), rtlMode: isRtlText(text), align: (isRtlText(text) ? 'right' : 'left') as 'right' | 'left' });

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = input.title;
  pptx.author = s.author || 'EchoMind';
  pptx.rtlMode = rtlDoc;

  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  cover.addShape('rect', { x: 0.6, y: 2.3, w: 0.9, h: 0.12, fill: { color: accent }, line: { color: accent } });
  cover.addText(input.title, { x: 0.6, y: 2.55, w: 12, h: 1.4, fontSize: 40, bold: true, color: '111111', ...textOptions(input.title) });
  const meta = [s.subtitle, [s.author, s.date].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  if (meta) cover.addText(meta, { x: 0.6, y: 4.0, w: 12, h: 1.2, fontSize: 18, color: '555555', ...textOptions(meta) });

  for (const plan of planSlides(input.markdown, s.timestamps, input.title)) {
    const slide = pptx.addSlide();
    slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: accent }, line: { color: accent } });
    slide.addText(plan.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: accent, ...textOptions(plan.title) });
    if (plan.table) {
      const header = plan.table.header.map((text) => ({ text, options: { bold: true, fill: { color: 'EEF0FA' }, ...textOptions(text) } }));
      const rows = plan.table.rows.map((row) => row.map((text) => ({ text, options: textOptions(text) })));
      slide.addTable([header, ...rows], { x: 0.6, y: 1.4, w: 12.1, fontSize: 13, border: { type: 'solid', color: 'CFCCC3', pt: 1 }, autoPage: false });
    } else {
      const bullets = plan.bullets.map((b) => ({
        text: b.text,
        options: { bullet: b.strong ? false : { indent: 18 }, indentLevel: b.depth, bold: b.strong, breakLine: true, ...textOptions(b.text) },
      }));
      slide.addText(bullets, { x: 0.6, y: 1.35, w: 12.1, h: 5.6, fontSize: 20, color: '222222', valign: 'top', paraSpaceAfter: 8, fit: 'shrink' });
    }
  }

  const note = sourceNote(input);
  if (note) {
    const end = pptx.addSlide();
    end.addText(note, { x: 0.6, y: 2.8, w: 12.1, h: 1.6, fontSize: 14, color: '666666', ...textOptions(note) });
  }

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
