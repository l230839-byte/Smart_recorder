import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiOutcome, CreateDocumentInput, CreateDocumentOutcome, DocumentExport } from '@shared/models';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  documentToHtml,
  documentToMarkdown,
  documentToText,
  EXPORT_FORMATS,
  safeFileName,
  templateById,
  transcriptToMarkdown,
  type DocumentInput,
  type DocumentSettings,
  type ExportFormat,
} from '@shared/documents';
import { DEFAULT_SUMMARY_OPTIONS, OUTPUT_LANGUAGES, type SummaryOptions } from '@shared/summaries';
import type { DocumentRepository } from '../db/documents';
import type { LibraryRepository } from '../db/library';
import type { SummaryRepository } from '../db/summaries';
import type { TranscriptRepository } from '../db/transcripts';
import { buildDocx } from '../documents/docx';
import { buildPptx } from '../documents/pptx';

export interface DocumentDeps {
  documents: DocumentRepository;
  library: LibraryRepository;
  transcripts: TranscriptRepository;
  summaries: SummaryRepository;
  /** AI Studio results, as Markdown, for study material in PDF and Word (prompt §13). */
  studioMarkdown?: (studioId: string) => { title: string; markdown: string } | null;
  /** Starts AI writing for a document. Returns why it cannot start, if it cannot. */
  requestAi: (recordingId: string, documentId: string | null, options: SummaryOptions) => AiOutcome;
  exportsDir: string;
  fontCss: () => Promise<string>;
  /** Prints the document page to PDF. Injected because it needs a browser window. */
  renderPdf: (documentId: string, settings: DocumentSettings) => Promise<Buffer>;
  changed: () => void;
  now?: () => number;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/** Creating, editing, versioning and exporting documents. Every format is built from the same draft. */
export class DocumentService {
  private readonly now: () => number;

  constructor(private readonly deps: DocumentDeps) {
    this.now = deps.now ?? Date.now;
  }

  create(input: CreateDocumentInput): CreateDocumentOutcome {
    const { library, transcripts, summaries, documents } = this.deps;
    const template = templateById(input.template);
    const recording = input.recordingId ? library.getRecording(input.recordingId) : null;
    if (input.recordingId && !recording) throw new Error('This recording no longer exists.');
    if (recording?.deletedAt) throw new Error('Restore this recording before making documents from it.');

    const settings: DocumentSettings = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      ...template.settings,
      date: recording ? new Date(recording.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' }) : new Date(this.now()).toLocaleDateString(undefined, { dateStyle: 'long' }),
      sources: !!recording,
    };
    const title = input.title?.trim() || (recording ? `${recording.title}: ${template.name}` : template.name);
    let markdown = '';

    if (input.source === 'ai') {
      if (!recording) throw new Error('Choose a recording for the AI to write from.');
      const options: SummaryOptions = {
        ...DEFAULT_SUMMARY_OPTIONS,
        format: 'custom',
        length: template.length,
        tone: template.tone,
        language: input.language || OUTPUT_LANGUAGES[0]!,
        instructions: [template.instructions, input.instructions?.trim()].filter(Boolean).join('\n'),
      };
      // Checked before anything is created, so a refused request leaves no empty document behind.
      const blocked = this.deps.requestAi(recording.id, null, options);
      if (!blocked.ok) return blocked;
      const id = documents.create({ recordingId: recording.id, title, template: template.id, settings, markdown: '' });
      const started = this.deps.requestAi(recording.id, id, options);
      if (!started.ok) {
        documents.delete(id);
        return started;
      }
      this.deps.changed();
      return { ok: true, documentId: id };
    }

    if (input.source === 'transcript') {
      if (!recording) throw new Error('Choose a recording.');
      const version = transcripts.current(recording.id);
      if (!version) return { ok: false, reason: 'needs-transcript' };
      markdown = transcriptToMarkdown(transcripts.segments(version.id), transcripts.speakerNames(recording.id));
    } else if (input.source === 'summary') {
      const summary = input.summaryId ? summaries.get(input.summaryId) : null;
      if (!summary) throw new Error('This summary no longer exists.');
      markdown = summary.markdown;
    } else if (input.source === 'studio') {
      const studio = input.studioId ? this.deps.studioMarkdown?.(input.studioId) : null;
      if (!studio) throw new Error('This result no longer exists, or is not finished yet.');
      markdown = studio.markdown;
    }

    const id = documents.create({ recordingId: recording?.id ?? null, title, template: template.id, settings, markdown });
    if (markdown) documents.saveVersion(id, 'First draft');
    this.deps.changed();
    return { ok: true, documentId: id };
  }

  private input(documentId: string): DocumentInput {
    const doc = this.deps.documents.get(documentId);
    if (!doc) throw new Error('This document no longer exists.');
    const recording = doc.recordingId ? this.deps.library.getRecording(doc.recordingId) : null;
    const version = recording ? this.deps.transcripts.current(recording.id) : null;
    return {
      title: doc.title,
      markdown: doc.markdown,
      settings: doc.settings,
      source: recording ? { title: recording.title, createdAt: recording.createdAt, durationMs: recording.durationMs } : null,
      transcript: recording && version ? { segments: this.deps.transcripts.segments(version.id), speakers: this.deps.transcripts.speakerNames(recording.id) } : null,
    };
  }

  async html(documentId: string): Promise<string> {
    return documentToHtml(this.input(documentId), await this.deps.fontCss());
  }

  async build(documentId: string, format: ExportFormat): Promise<Buffer> {
    const input = this.input(documentId);
    switch (format) {
      case 'pdf':
        return this.deps.renderPdf(documentId, input.settings);
      case 'docx':
        return buildDocx(input);
      case 'pptx':
        return buildPptx(input);
      case 'html':
        return Buffer.from(documentToHtml(input, await this.deps.fontCss()), 'utf8');
      case 'md':
        return Buffer.from(`﻿${documentToMarkdown(input)}`, 'utf8');
      case 'txt':
        return Buffer.from(`﻿${documentToText(input)}`, 'utf8');
    }
  }

  /** Keeps a copy in EchoMind's own folder, so it can be found, opened and shared again later. */
  async export(documentId: string, format: ExportFormat): Promise<DocumentExport> {
    if (!(format in EXPORT_FORMATS)) throw new Error('Unknown export format.');
    const doc = this.deps.documents.get(documentId);
    if (!doc) throw new Error('This document no longer exists.');
    const data = await this.build(documentId, format);
    const dir = join(this.deps.exportsDir, documentId);
    await mkdir(dir, { recursive: true });
    const created = this.now();
    const base = `${safeFileName(doc.title)} ${stamp(created)}`;
    const extension = EXPORT_FORMATS[format].extension;
    // Stored with "/" so the name reads the same everywhere. Two exports in the same second never share a file.
    let fileName = `${documentId}/${base}.${extension}`;
    for (let n = 2; existsSync(join(this.deps.exportsDir, fileName)); n++) fileName = `${documentId}/${base} (${n}).${extension}`;
    const path = join(this.deps.exportsDir, fileName);
    await writeFile(path, data, { flag: 'wx' });
    const { size } = await stat(path);
    const id = this.deps.documents.addExport(documentId, format, fileName, size);
    this.deps.changed();
    return { id, documentId, documentTitle: doc.title, format, fileName, sizeBytes: size, createdAt: created, exists: true };
  }

  listExports(): DocumentExport[] {
    return this.deps.documents.exports().map((e) => ({ ...e, exists: existsSync(join(this.deps.exportsDir, e.fileName)) }));
  }

  exportPath(exportId: string): string {
    const found = this.deps.documents.getExport(exportId);
    if (!found) throw new Error('This file is no longer in the list.');
    const path = join(this.deps.exportsDir, found.fileName);
    if (!existsSync(path)) throw new Error('This file was removed from EchoMind’s folder. Export the document again.');
    return path;
  }

  async deleteExport(exportId: string): Promise<void> {
    const found = this.deps.documents.getExport(exportId);
    if (!found) return;
    await rm(join(this.deps.exportsDir, found.fileName), { force: true });
    this.deps.documents.deleteExport(exportId);
    this.deps.changed();
  }

  async delete(documentId: string): Promise<void> {
    const files = this.deps.documents.delete(documentId);
    await Promise.all(files.map((f) => rm(join(this.deps.exportsDir, f), { force: true })));
    await rm(join(this.deps.exportsDir, documentId), { recursive: true, force: true });
    this.deps.changed();
  }
}
