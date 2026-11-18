import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@shared/documents';
import { RECORDING_MODES, type RecordingMode } from '@shared/models';
import { DEFAULT_SUMMARY_OPTIONS, type SummaryOptions } from '@shared/summaries';
import type { Segment } from '@shared/transcript';
import type { DocumentRepository } from '../db/documents';
import type { LibraryRepository } from '../db/library';
import type { SummaryRepository } from '../db/summaries';
import type { TranscriptRepository } from '../db/transcripts';
import { extractArchive, inspectArchive, writeArchive } from './archive';
import type { IngestPipeline } from './ingest';

const MAX_BUNDLE_BYTES = 8 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;

/** What a share bundle carries besides the audio. Version 1. */
export interface BundleManifest {
  format: 'echomind-bundle';
  version: 1;
  recording: { title: string; description: string; mode: RecordingMode; createdAt: number; tags: string[]; bookmarks: { positionMs: number; label: string; note: string | null }[] };
  audio: string;
  transcript: { language: string | null; provider: string; model: string; speakers: Record<string, string>; segments: Segment[] } | null;
  summaries: { label: string; options: SummaryOptions; markdown: string; provider: string; model: string }[];
  chapters: { idx: number; startMs: number; endMs: number; title: string; summary: string }[];
  documents: { title: string; template: string; settings: DocumentSettings; markdown: string }[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const arr = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);

/** A bundle comes from someone else, so every field is checked and limited before it is used. */
export function validateManifest(raw: unknown): BundleManifest {
  const m = raw as Record<string, unknown> | null;
  if (m?.format !== 'echomind-bundle' || m.version !== 1) throw new Error('This bundle was made by a different version of EchoMind and cannot be read.');
  const rec = (m.recording ?? {}) as Record<string, unknown>;
  const audio = str(m.audio, 200);
  if (!/^audio\/[\w.-]+$/.test(audio)) throw new Error('This bundle has no usable audio.');
  const t = m.transcript as Record<string, unknown> | null | undefined;
  const segments: Segment[] = t
    ? arr(t.segments, 200_000).map((s, i) => {
        const x = s as Record<string, unknown>;
        const startMs = num(x.startMs);
        return { idx: i, startMs, endMs: Math.max(startMs, num(x.endMs)), text: str(x.text, 5000), speaker: typeof x.speaker === 'string' ? x.speaker.slice(0, 20) : null, confidence: null };
      })
    : [];
  return {
    format: 'echomind-bundle',
    version: 1,
    recording: {
      title: str(rec.title, 200).trim() || 'Shared recording',
      description: str(rec.description, 5000),
      mode: RECORDING_MODES.includes(rec.mode as RecordingMode) ? (rec.mode as RecordingMode) : 'notes',
      createdAt: num(rec.createdAt) || Date.now(),
      tags: arr(rec.tags, 50).map((x) => str(x, 60)).filter(Boolean),
      bookmarks: arr(rec.bookmarks, 2000).map((b) => {
        const x = b as Record<string, unknown>;
        return { positionMs: num(x.positionMs), label: str(x.label, 200) || 'Bookmark', note: typeof x.note === 'string' ? x.note.slice(0, 5000) : null };
      }),
    },
    audio,
    transcript:
      t && segments.length
        ? {
            language: typeof t.language === 'string' ? t.language.slice(0, 20) : null,
            provider: str(t.provider, 40) || 'bundle',
            model: str(t.model, 80) || 'shared',
            speakers: Object.fromEntries(Object.entries((t.speakers ?? {}) as Record<string, unknown>).slice(0, 50).map(([k, v]) => [k.slice(0, 20), str(v, 100)])),
            segments: segments.filter((s) => s.text.trim()).map((s, i) => ({ ...s, idx: i })),
          }
        : null,
    summaries: arr(m.summaries, 200).map((s) => {
      const x = s as Record<string, unknown>;
      return { label: str(x.label, 200) || 'Summary', options: { ...DEFAULT_SUMMARY_OPTIONS, ...((x.options ?? {}) as Partial<SummaryOptions>) }, markdown: str(x.markdown, 2_000_000), provider: str(x.provider, 40) || 'bundle', model: str(x.model, 80) || 'shared' };
    }),
    chapters: arr(m.chapters, 500).map((c, i) => {
      const x = c as Record<string, unknown>;
      return { idx: i, startMs: num(x.startMs), endMs: num(x.endMs), title: str(x.title, 200), summary: str(x.summary, 1000) };
    }),
    documents: arr(m.documents, 200).map((d) => {
      const x = d as Record<string, unknown>;
      return { title: str(x.title, 200) || 'Document', template: str(x.template, 60) || 'custom', settings: { ...DEFAULT_DOCUMENT_SETTINGS, ...((x.settings ?? {}) as Partial<DocumentSettings>) }, markdown: str(x.markdown, 5_000_000) };
    }),
  };
}

export interface BundleDeps {
  library: LibraryRepository;
  transcripts: TranscriptRepository;
  summaries: SummaryRepository;
  documents: DocumentRepository;
  pipeline: Pick<IngestPipeline, 'ingest'>;
  mediaDir: string;
  tempDir: string;
  appVersion: string;
}

/**
 * Portable share bundles (prompt §15.7): one file with a recording, its transcript, summaries, chapters
 * and documents, to send through any app. Importing goes through the normal pipeline, so a bundle's audio
 * is checked like any other file.
 */
export class BundleService {
  constructor(private readonly deps: BundleDeps) {}

  async export(recordingId: string, file: string): Promise<number> {
    const { library, transcripts, summaries, documents } = this.deps;
    const rec = library.getRecording(recordingId);
    const media = library.mediaFile(recordingId);
    if (!rec || !media) throw new Error('This recording no longer exists.');
    const version = transcripts.current(recordingId);
    const audio = `audio/recording${extname(media.fileName)}`;
    const manifest: BundleManifest = {
      format: 'echomind-bundle',
      version: 1,
      recording: { title: rec.title, description: rec.description, mode: rec.mode, createdAt: rec.createdAt, tags: rec.tags.map((t) => t.name), bookmarks: library.bookmarks(recordingId).map((b) => ({ positionMs: b.positionMs, label: b.label, note: b.note })) },
      audio,
      transcript: version ? { language: version.language, provider: version.provider, model: version.model, speakers: transcripts.speakerNames(recordingId), segments: transcripts.segments(version.id) } : null,
      summaries: summaries.list(recordingId).map((s) => ({ label: s.label, options: s.options, markdown: s.markdown, provider: s.provider, model: s.model })),
      chapters: summaries.chapters(recordingId),
      documents: documents.list(recordingId).map((d) => ({ title: d.title, template: d.template, settings: d.settings, markdown: d.markdown })),
    };
    return writeArchive(
      file,
      { kind: 'bundle', createdAt: Date.now(), appVersion: this.deps.appVersion, summary: { title: rec.title, durationMs: rec.durationMs } },
      [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
        { name: audio, path: join(this.deps.mediaDir, media.fileName) },
      ],
      null,
    );
  }

  async import(file: string): Promise<{ recordingId: string; title: string }> {
    const info = await inspectArchive(file);
    if (info.kind !== 'bundle') throw new Error('This is a backup, not a share bundle. Restore it from Backup instead.');
    const dir = join(this.deps.tempDir, `bundle-${randomUUID()}`);
    try {
      await extractArchive(file, dir, null, { kind: 'bundle', maxBytes: MAX_BUNDLE_BYTES });
      const manifestPath = join(dir, 'manifest.json');
      const manifestSize = (await stat(manifestPath).catch(() => null))?.size;
      if (manifestSize === undefined || manifestSize > MAX_MANIFEST_BYTES) throw new Error('This bundle is damaged.');
      let manifest: BundleManifest;
      try {
        manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      } catch (e) {
        throw e instanceof SyntaxError ? new Error('This bundle is damaged.') : e;
      }
      const { recordingId } = await this.deps.pipeline.ingest({
        workFile: join(dir, ...manifest.audio.split('/')),
        title: manifest.recording.title,
        description: manifest.recording.description,
        mode: manifest.recording.mode,
        source: 'opened',
        originalName: file.split(/[\\/]/).pop() ?? null,
        createdAt: manifest.recording.createdAt,
        bookmarks: manifest.recording.bookmarks,
      });
      const { library, transcripts, summaries, documents } = this.deps;
      for (const tag of manifest.recording.tags) library.addTag(recordingId, tag);
      if (manifest.transcript) {
        const versionId = transcripts.addOriginal(recordingId, manifest.transcript.provider, manifest.transcript.model, manifest.transcript.language, manifest.transcript.segments);
        for (const [label, name] of Object.entries(manifest.transcript.speakers)) if (name.trim()) transcripts.renameSpeaker(recordingId, label, name);
        if (manifest.chapters.length) summaries.saveChapters(recordingId, versionId, manifest.chapters);
      }
      for (const s of manifest.summaries) summaries.add({ recordingId, label: s.label, options: s.options, markdown: s.markdown, provider: s.provider, model: s.model, transcriptVersionId: null, droppedCitations: 0, truncated: false });
      for (const d of manifest.documents) {
        const id = documents.create({ recordingId, title: d.title, template: d.template, settings: d.settings, markdown: d.markdown });
        documents.saveVersion(id, 'Imported');
      }
      return { recordingId, title: manifest.recording.title };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
