import { spawn } from 'node:child_process';
import type { Segment } from '@shared/transcript';

/** One stretch of one voice, in milliseconds, as sherpa-onnx reports it. */
export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speaker: string;
}

/** sherpa-onnx prints one line per turn: "6.578 -- 7.372 speaker_00". Everything else is ignored. */
export function parseDiarization(output: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(speaker_\d+)\s*$/.exec(line);
    if (m) turns.push({ startMs: Math.round(Number(m[1]) * 1000), endMs: Math.round(Number(m[2]) * 1000), speaker: m[3]! });
  }
  return turns.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Gives each transcript line the voice that speaks most during it. Speakers are named in order of first
 * appearance, "Speaker A" for whoever speaks first, because sherpa-onnx's numbers carry no meaning. A line
 * no voice overlaps (music, a pause) takes the nearest turn's speaker, within two seconds, and is
 * otherwise left unlabelled rather than guessed.
 */
export function assignSpeakers(segments: Segment[], turns: SpeakerTurn[]): Segment[] {
  const names = new Map<string, string>();
  for (const t of turns) if (!names.has(t.speaker) && names.size < 26) names.set(t.speaker, `Speaker ${String.fromCharCode(65 + names.size)}`);
  return segments.map((s) => {
    const overlap = new Map<string, number>();
    for (const t of turns) {
      const shared = Math.min(s.endMs, t.endMs) - Math.max(s.startMs, t.startMs);
      if (shared > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + shared);
    }
    let best = [...overlap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) {
      const near = turns
        .map((t) => ({ t, gap: Math.max(t.startMs - s.endMs, s.startMs - t.endMs, 0) }))
        .filter((x) => x.gap <= 2000)
        .sort((a, b) => a.gap - b.gap)[0];
      best = near?.t.speaker;
    }
    return { ...s, speaker: best ? (names.get(best) ?? null) : null };
  });
}

export interface DiarizeOptions {
  exe: string;
  segmentationModel: string;
  voiceModel: string;
  /** 16 kHz mono WAV of the whole recording. */
  wavPath: string;
  /** When the person knows how many people spoke; otherwise found automatically. */
  speakers: number | null;
  threads: number;
  signal: AbortSignal;
}

/**
 * Runs sherpa-onnx's offline speaker diarization over the whole recording at once, so each voice keeps one
 * label from start to end. Nothing is sent anywhere.
 */
export function runDiarization(o: DiarizeOptions): Promise<SpeakerTurn[]> {
  // A threshold of 0.5 kept two similar synthetic voices apart in testing; a known count is better still.
  const clustering = o.speakers ? [`--clustering.num-clusters=${o.speakers}`] : ['--clustering.cluster-threshold=0.5'];
  const args = [
    `--segmentation.pyannote-model=${o.segmentationModel}`,
    `--embedding.model=${o.voiceModel}`,
    `--segmentation.num-threads=${o.threads}`,
    `--embedding.num-threads=${o.threads}`,
    ...clustering,
    o.wavPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(o.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const onAbort = () => child.kill();
    o.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => reject(new Error('Finding speakers could not start on this computer.')));
    child.on('close', (code) => {
      o.signal.removeEventListener('abort', onAbort);
      if (o.signal.aborted) return reject(new DOMException('Canceled', 'AbortError'));
      if (code !== 0) return reject(new Error(/memory|alloc/i.test(err) ? 'This computer ran out of memory while finding speakers.' : `Finding speakers stopped unexpectedly (code ${code}).`));
      // The tool writes its turns to one stream or the other depending on the build; both are read.
      resolve(parseDiarization(`${out}\n${err}`));
    });
  });
}
