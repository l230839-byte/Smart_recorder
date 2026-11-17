import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { DocumentRepository } from '../../src/main/db/documents';
import { LibraryRepository } from '../../src/main/db/library';
import { SummaryRepository } from '../../src/main/db/summaries';
import { TranscriptRepository } from '../../src/main/db/transcripts';
import { buildDocx } from '../../src/main/documents/docx';
import { loadFontCss } from '../../src/main/documents/fonts';
import { buildPptx } from '../../src/main/documents/pptx';
import { DocumentService } from '../../src/main/services/documents';
import {
  csvCell,
  DEFAULT_DOCUMENT_SETTINGS,
  DOCUMENT_TEMPLATES,
  documentDirection,
  documentToHtml,
  documentToMarkdown,
  documentToText,
  isRtlText,
  planSlides,
  safeFileName,
  transcriptToCsv,
  transcriptToMarkdown,
  type DocumentInput,
} from '../../src/shared/documents';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, text: string, speaker: string | null = null): Segment => ({ idx, startMs, endMs: startMs + 1000, text, speaker, confidence: null });

const MARKDOWN = `## Overview

Neural networks learn from data [3:05](cite:185000).

- First point with **bold** text
  - Nested point
- Second point

1. Step one
2. Step two

| Term | Meaning |
| --- | --- |
| Gradient | Direction of steepest change |

> A quoted remark

### Details

یہ اردو میں ایک جملہ ہے۔
`;

function input(over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    title: 'Machine Learning Lecture',
    markdown: MARKDOWN,
    settings: { ...DEFAULT_DOCUMENT_SETTINGS, toc: true },
    source: { title: 'ML lecture', createdAt: Date.UTC(2026, 10, 1), durationMs: 3_600_000 },
    transcript: { segments: [seg(0, 0, 'Hello class', 'A'), seg(1, 5000, 'سوال یہ ہے', 'B')], speakers: { A: 'Dr. Khan' } },
    ...over,
  };
}

describe('templates', () => {
  it('include the nine from the prompt', () => {
    expect(DOCUMENT_TEMPLATES.map((t) => t.name)).toEqual([
      'Academic Notes',
      'Detailed Lecture Report',
      'Meeting Minutes',
      'Business Report',
      'Interview Transcript',
      'Study Guide',
      'Executive Summary',
      'Research Notes',
      'Custom Document',
    ]);
    expect(new Set(DOCUMENT_TEMPLATES.map((t) => t.id)).size).toBe(9);
  });
});

describe('direction', () => {
  it('detects Urdu and mixed text', () => {
    expect(isRtlText('یہ اردو ہے')).toBe(true);
    expect(isRtlText('Hello world')).toBe(false);
    expect(isRtlText('یہ اردو ہے with English')).toBe(true);
    expect(isRtlText('A long English sentence with one لفظ')).toBe(false);
    expect(documentDirection({ ...DEFAULT_DOCUMENT_SETTINGS, direction: 'rtl' }, 'Hello')).toBe('rtl');
  });
});

describe('HTML', () => {
  it('escapes everything, so content cannot inject markup or script', () => {
    const html = documentToHtml(input({ title: '<script>alert(1)</script>', markdown: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) **<b>**' }), '');
    expect(html).not.toMatch(/<script>alert|<img src|javascript:|<b>/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/<script/gi)).toBeNull();
  });

  it('renders every block and honors the settings', () => {
    const html = documentToHtml(input(), '/*fonts*/');
    for (const part of ['<table>', '<ol>', '<ul>', '<blockquote', 'class="sheet cover"', 'Contents', '/*fonts*/']) expect(html).toContain(part);
    expect(documentToHtml(input({ settings: { ...DEFAULT_DOCUMENT_SETTINGS, transcript: true } }), '')).toContain('Dr. Khan');
    expect(html).toContain('class="cite">3:05');
    expect(html).toContain('Source: “ML lecture”');
    expect(html).not.toContain('class="transcript"');
  });

  it('hides times and sources when turned off, and adds the transcript when asked', () => {
    const html = documentToHtml(input({ settings: { ...DEFAULT_DOCUMENT_SETTINGS, timestamps: false, sources: false, transcript: true, speakerLabels: false } }), '');
    expect(html).not.toContain('class="cite"');
    expect(html).not.toContain('Source:');
    expect(html).toContain('class="transcript"');
    expect(html).not.toContain('Dr. Khan');
  });

  it('sends Urdu to the embedded Urdu font before any system font that also has Arabic letters', () => {
    for (const font of ['sans', 'serif'] as const) {
      for (const urduStyle of ['nastaliq', 'naskh'] as const) {
        const html = documentToHtml(input({ settings: { ...DEFAULT_DOCUMENT_SETTINGS, font, urduStyle } }), '');
        const stack = /body \{[^}]*font-family: ([^;]+);/.exec(html)![1]!;
        const urdu = stack.indexOf(urduStyle === 'nastaliq' ? 'Noto Nastaliq Urdu' : 'Noto Naskh Arabic');
        expect(urdu, stack).toBeGreaterThan(0);
        expect(urdu, stack).toBeLessThan(stack.indexOf('Segoe UI'));
      }
    }
  });

  it('marks Urdu blocks for right-to-left layout and sets the page language', () => {
    const html = documentToHtml(input({ markdown: 'یہ اردو میں ہے', settings: { ...DEFAULT_DOCUMENT_SETTINGS, language: 'ur' } }), '');
    expect(html).toContain('<html dir="rtl" lang="ur">');
    expect(html).toContain('<p dir="auto">');
  });
});

describe('Markdown and text exports', () => {
  it('keep times readable and drop the internal link form', () => {
    const md = documentToMarkdown(input());
    expect(md.startsWith('# Machine Learning Lecture')).toBe(true);
    expect(md).toContain('[3:05]');
    expect(md).not.toContain('cite:');
    const txt = documentToText(input());
    expect(txt).toContain('MACHINE LEARNING LECTURE');
    expect(txt).toContain('• First point with bold text');
    expect(txt).toContain('Gradient | Direction of steepest change');
    expect(txt).not.toContain('**');
  });

  it('hiding times removes them cleanly and leaves the rest of the text exactly as written', () => {
    const off = { ...DEFAULT_DOCUMENT_SETTINGS, timestamps: false, sources: false };
    const markdown = 'Learning from data [3:05](cite:185000). Note : spacing  stays.';
    expect(documentToText(input({ markdown, settings: off }))).toContain('Learning from data. Note : spacing  stays.');
    expect(documentToMarkdown(input({ markdown, settings: off }))).toContain('Learning from data. Note : spacing  stays.');
  });
});

describe('CSV', () => {
  it('quotes properly and blocks spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    for (const start of ['+', '-', '@']) expect(csvCell(`${start}1`).startsWith("'")).toBe(true);
    const csv = transcriptToCsv([seg(0, 3_661_001, '=1+1', 'A')], { A: 'Ali' });
    expect(csv).toBe("Start,End,Speaker,Text\r\n01:01:01.001,01:01:02.001,Ali,'=1+1\r\n");
  });
});

describe('transcript documents', () => {
  it('group turns by speaker and keep a time for every line', () => {
    const md = transcriptToMarkdown([seg(0, 0, 'Hi', 'A'), seg(1, 1000, 'there', 'A'), seg(2, 2000, 'Hello', 'B')], { A: 'Sara' });
    expect(md).toBe('## Transcript\n\n**Sara:** Hi [0:00](cite:0) there [0:01](cite:1000)\n\n**Speaker B:** Hello [0:02](cite:2000)\n');
  });
});

describe('slides', () => {
  it('make one slide per section, continue long ones, and give tables their own', () => {
    const many = `## Big\n\n${Array.from({ length: 10 }, (_, i) => `- Point ${i}`).join('\n')}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n`;
    const slides = planSlides(many, false, 'Doc');
    expect(slides.map((s) => s.title)).toEqual(['Big', 'Big (continued)', 'Big (continued)']);
    expect(slides[0]!.bullets).toHaveLength(7);
    expect(slides[2]!.table).toEqual({ header: ['A', 'B'], rows: [['1', '2']] });
  });

  it('shorten very long paragraphs and handle content before any heading', () => {
    const slides = planSlides(`Intro ${'word '.repeat(100)}`, false, 'Fallback');
    expect(slides[0]!.title).toBe('Fallback');
    expect(slides[0]!.bullets[0]!.text.length).toBeLessThanOrEqual(220);
    expect(planSlides('', false, 'x')).toEqual([]);
  });

  it('split big tables across slides', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| ${i} | x |`).join('\n');
    const slides = planSlides(`## T\n\n| N | V |\n| --- | --- |\n${rows}\n`, false, 'D');
    expect(slides.map((s) => s.table?.rows.length)).toEqual([9, 9, 2]);
  });
});

describe('file names', () => {
  it('are safe on Windows', () => {
    expect(safeFileName('a<b>:c/d\\e|f?g*h"')).toBe('a b c d e f g h');
    expect(safeFileName('   ')).toBe('Document');
    expect(safeFileName('Report...')).toBe('Report');
    expect(safeFileName('اردو رپورٹ')).toBe('اردو رپورٹ');
  });
});

describe('Word files are real documents', () => {
  it('contain the content, the structure, right-to-left paragraphs and a table of contents', async () => {
    const buffer = await buildDocx(input({ settings: { ...DEFAULT_DOCUMENT_SETTINGS, toc: true, transcript: true, header: 'Course notes' } }));
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml']));
    const xml = await zip.file('word/document.xml')!.async('string');
    for (const text of ['Machine Learning Lecture', 'Neural networks learn from data', 'Gradient', 'Direction of steepest change', 'A quoted remark', 'یہ اردو میں ایک جملہ ہے۔', 'Hello class', 'Dr. Khan']) expect(xml).toContain(text);
    expect(xml).toContain('<w:bidi/>');
    expect(xml).toContain('<w:rtl/>');
    expect(xml).toContain('TOC \\h \\o &quot;1-2&quot;');
    expect(xml).toContain('w:fldCharType="begin" w:dirty="true"');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:numPr>');
    const header = Object.keys(zip.files).find((f) => /word\/header\d*\.xml/.test(f));
    expect(await zip.file(header!)!.async('string')).toContain('Course notes');
  });

  it('page size follows the settings', async () => {
    const xml = await (await JSZip.loadAsync(await buildDocx(input({ settings: { ...DEFAULT_DOCUMENT_SETTINGS, pageSize: 'Letter' } })))).file('word/document.xml')!.async('string');
    expect(xml).toMatch(/w:w="12240"/);
  });
});

describe('PowerPoint files are real presentations', () => {
  it('have a title slide and one slide per section', async () => {
    const zip = await JSZip.loadAsync(await buildPptx(input()));
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(3);
    const all = (await Promise.all(slides.map((f) => zip.file(f)!.async('string')))).join('\n');
    for (const text of ['Machine Learning Lecture', 'Overview', 'Gradient', 'یہ اردو میں ایک جملہ ہے۔']) expect(all).toContain(text);
    expect(all).toContain('rtl="1"');
  });
});

describe('fonts', () => {
  it('embed Latin and Urdu faces as data, with no file or network references', async () => {
    const css = await loadFontCss(resolve('node_modules'));
    for (const family of ['Inter Variable', 'Noto Serif', 'Noto Nastaliq Urdu', 'Noto Naskh Arabic']) expect(css).toContain(family);
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).not.toMatch(/url\(\.\/|url\(http/);
    expect(css.length).toBeLessThan(3_000_000);
    // Only the scripts each face is for: Latin for Inter and Noto Serif, Arabic script for the Urdu faces.
    expect(css.match(/@font-face/g)).toHaveLength(2 + 4 + 2 + 2);
    expect(css.match(/font-family: 'Noto Naskh Arabic'/g)).toHaveLength(2);
  });
});

describe('document service', () => {
  let db: Db;
  let library: LibraryRepository;
  let documents: DocumentRepository;
  let transcripts: TranscriptRepository;
  let summaries: SummaryRepository;
  let service: DocumentService;
  let aiCalls: { documentId: string | null }[];
  let aiResult: { ok: true; jobId: string } | { ok: false; reason: 'offline-only'; provider: 'groq'; purpose: 'text' };
  let exportsDir: string;
  let id: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    library = new LibraryRepository(db);
    documents = new DocumentRepository(db);
    transcripts = new TranscriptRepository(db);
    summaries = new SummaryRepository(db);
    exportsDir = mkdtempSync(join(tmpdir(), 'echomind-docs-'));
    aiCalls = [];
    aiResult = { ok: true, jobId: 'j' };
    service = new DocumentService({
      documents,
      library,
      transcripts,
      summaries,
      requestAi: (_rid, documentId) => {
        aiCalls.push({ documentId });
        return aiResult;
      },
      exportsDir,
      fontCss: async () => '',
      renderPdf: async () => Buffer.from('%PDF-1.7 test'),
      changed: () => undefined,
    });
    id = library.insertRecording({ title: 'Weekly sync', mode: 'meeting', source: 'native', format: 'OGG', codec: 'Opus', durationMs: 60_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'f.ogg', mime: 'audio/ogg', peaks: new Uint8Array(4) });
    transcripts.addOriginal(id, 'groq', 'm', 'en', [seg(0, 0, 'We agreed to ship on Friday', 'A')]);
  });

  afterEach(() => db.close());

  it('a refused AI request leaves no empty document behind', () => {
    aiResult = { ok: false, reason: 'offline-only', provider: 'groq', purpose: 'text' };
    expect(service.create({ recordingId: id, template: 'meeting-minutes', source: 'ai' })).toMatchObject({ ok: false, reason: 'offline-only' });
    expect(documents.list()).toEqual([]);
  });

  it('an AI document is created, then its job is started for it', () => {
    const out = service.create({ recordingId: id, template: 'meeting-minutes', source: 'ai', instructions: 'Keep it short' }) as { ok: true; documentId: string };
    expect(out.ok).toBe(true);
    expect(aiCalls).toEqual([{ documentId: null }, { documentId: out.documentId }]);
    expect(documents.get(out.documentId)).toMatchObject({ title: 'Weekly sync: Meeting Minutes', template: 'meeting-minutes', markdown: '' });
  });

  it('a transcript document needs no AI and starts with a first version', () => {
    const out = service.create({ recordingId: id, template: 'interview-transcript', source: 'transcript' }) as { ok: true; documentId: string };
    expect(aiCalls).toEqual([]);
    const doc = documents.get(out.documentId)!;
    expect(doc.markdown).toContain('We agreed to ship on Friday');
    expect(documents.versions(out.documentId).map((v) => v.label)).toEqual(['First draft']);
    expect(library.list({ view: 'all', sort: 'newest', text: 'friday' })).toHaveLength(1);
  });

  it('a summary becomes a document, and a blank one starts empty', () => {
    const sid = summaries.add({ recordingId: id, label: 'x', options: {} as never, markdown: '## Decisions\n\n- Ship Friday', provider: 'fake', model: 'demo', transcriptVersionId: null, droppedCitations: 0, truncated: false });
    const fromSummary = service.create({ recordingId: id, template: 'business-report', source: 'summary', summaryId: sid }) as { ok: true; documentId: string };
    expect(documents.get(fromSummary.documentId)!.markdown).toContain('Ship Friday');
    const blank = service.create({ recordingId: null, template: 'custom', source: 'blank', title: 'My notes' }) as { ok: true; documentId: string };
    expect(documents.get(blank.documentId)).toMatchObject({ title: 'My notes', markdown: '', recordingId: null });
  });

  it('versions keep history, and restoring never loses the current draft', () => {
    const { documentId } = service.create({ recordingId: id, template: 'interview-transcript', source: 'transcript' }) as { ok: true; documentId: string };
    documents.update(documentId, { markdown: 'Edited text' });
    documents.saveVersion(documentId, 'My edit');
    const first = documents.versions(documentId).find((v) => v.label === 'First draft')!;
    documents.update(documentId, { markdown: 'Unsaved work' });
    documents.restoreVersion(documentId, first.id);
    expect(documents.get(documentId)!.markdown).toContain('We agreed to ship on Friday');
    expect(documents.versions(documentId).map((v) => v.label)).toEqual(['Before restoring an older version', 'My edit', 'First draft']);
  });

  it('every format exports a real file, kept where it can be found later', async () => {
    const { documentId } = service.create({ recordingId: id, template: 'meeting-minutes', source: 'transcript' }) as { ok: true; documentId: string };
    for (const format of ['pdf', 'docx', 'pptx', 'html', 'md', 'txt'] as const) {
      const exported = await service.export(documentId, format);
      const bytes = readFileSync(join(exportsDir, exported.fileName));
      expect(bytes.length, format).toBe(exported.sizeBytes);
      if (format === 'docx' || format === 'pptx') expect(bytes.subarray(0, 2).toString(), format).toBe('PK');
      if (format === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      if (format === 'html') expect(bytes.toString()).toMatch(/^<!doctype html>/);
      if (format === 'md' || format === 'txt') expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    }
    expect(service.listExports().map((e) => e.format).sort()).toEqual(['docx', 'html', 'md', 'pdf', 'pptx', 'txt']);
    expect(service.listExports().every((e) => e.exists)).toBe(true);
  });

  it('two exports in the same second get their own files, and a missing file is reported', async () => {
    const { documentId } = service.create({ recordingId: id, template: 'meeting-minutes', source: 'transcript' }) as { ok: true; documentId: string };
    const fixed = new DocumentService({
      documents,
      library,
      transcripts,
      summaries,
      requestAi: () => aiResult,
      exportsDir,
      fontCss: async () => '',
      renderPdf: async () => Buffer.from('%PDF-'),
      changed: () => undefined,
      now: () => new Date(2026, 10, 17, 9, 30, 0).getTime(),
    });
    const a = await fixed.export(documentId, 'md');
    const b = await fixed.export(documentId, 'md');
    // The ":" in the title is not allowed in Windows file names, so it goes.
    expect(a.fileName).toBe(`${documentId}/Weekly sync Meeting Minutes 2026-11-17 09.30.00.md`);
    expect(b.fileName).toBe(a.fileName.replace(/\.md$/, ' (2).md'));
    await fixed.deleteExport(a.id);
    expect(readFileSync(join(exportsDir, b.fileName)).length).toBe(b.sizeBytes);
    rmSync(join(exportsDir, b.fileName));
    expect(fixed.listExports().find((e) => e.id === b.id)?.exists).toBe(false);
    expect(() => fixed.exportPath(b.id)).toThrow(/Export the document again/);
  });

  it('deleting a document or its recording removes its exported files', async () => {
    const { documentId } = service.create({ recordingId: id, template: 'meeting-minutes', source: 'transcript' }) as { ok: true; documentId: string };
    const exported = await service.export(documentId, 'md');
    expect(documents.exportFilesForRecordings([id])).toEqual([exported.fileName]);
    await service.delete(documentId);
    expect(service.listExports()).toEqual([]);
    expect(() => readFileSync(join(exportsDir, exported.fileName))).toThrow();
    library.deleteForever([id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 0 });
  });

  it('a trashed recording cannot get new documents', () => {
    library.trash([id]);
    expect(() => service.create({ recordingId: id, template: 'custom', source: 'transcript' })).toThrow(/Restore/);
  });
});

describe('performance', () => {
  it('a three-hour transcript (5,000 segments) becomes HTML, Word and slides quickly', async () => {
    const segments = Array.from({ length: 5000 }, (_, i) => seg(i, i * 2000, `Sentence number ${i} about neural networks and گفتگو.`, i % 2 ? 'A' : 'B'));
    const markdown = transcriptToMarkdown(segments, {});
    const big = input({ markdown, settings: { ...DEFAULT_DOCUMENT_SETTINGS, toc: true }, transcript: null });
    const time = async (run: () => unknown) => {
      const t = performance.now();
      await run();
      return performance.now() - t;
    };
    const html = await time(() => documentToHtml(big, ''));
    const docx = await time(() => buildDocx(big));
    const pptx = await time(() => buildPptx(big));
    console.warn(`performance: 5,000 segments: HTML ${html.toFixed(0)} ms, DOCX ${docx.toFixed(0)} ms, PPTX ${pptx.toFixed(0)} ms`);
    expect(html).toBeLessThan(1000);
    expect(docx).toBeLessThan(5000);
    expect(pptx).toBeLessThan(5000);
  }, 30_000);
});
