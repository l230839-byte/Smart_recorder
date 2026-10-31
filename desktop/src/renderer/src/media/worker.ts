import {
  ALL_FORMATS,
  AudioSampleSink,
  Conversion,
  FlacOutputFormat,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  StreamSource,
  StreamTarget,
  WavOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { PEAK_BUCKETS, type MediaProbe, type OutputContainer } from '@shared/media';
import type { MediaBridge, MediaJob } from '@shared/media-jobs';

declare global {
  interface Window {
    mediaBridge: MediaBridge;
  }
}

const bridge = window.mediaBridge;

function openInput(handle: number): Input {
  const source = new StreamSource({
    getSize: () => bridge.size(handle),
    read: (start, end) => bridge.read(handle, start, end),
    maxCacheSize: 8 * 1024 * 1024,
  });
  return new Input({ source, formats: ALL_FORMATS });
}

function outputFormat(container: OutputContainer) {
  switch (container) {
    case 'ogg':
      return new OggOutputFormat();
    case 'm4a':
      return new Mp4OutputFormat();
    case 'mp3':
      return new Mp3OutputFormat();
    case 'flac':
      return new FlacOutputFormat();
    case 'wav':
      return new WavOutputFormat();
  }
}

async function probe(handle: number): Promise<MediaProbe> {
  const input = openInput(handle);
  try {
    const [format, audio, video] = await Promise.all([input.getFormat(), input.getPrimaryAudioTrack(), input.getPrimaryVideoTrack()]);
    return {
      container: format.name,
      hasVideo: video != null,
      codec: audio?.codec ?? null,
      sampleRate: audio?.sampleRate ?? 0,
      channels: audio?.numberOfChannels ?? 0,
      durationMs: Math.round((await input.computeDuration()) * 1000),
      canDecode: audio ? await audio.canDecode() : false,
    };
  } finally {
    input.dispose();
  }
}

/**
 * Decodes the whole file in a stream, so memory stays flat however long it is. This doubles as the
 * corruption check: a damaged file fails here rather than later, in front of the user.
 */
async function analyze(jobId: number, handle: number, durationMs: number): Promise<{ peaks: Uint8Array; decodedMs: number }> {
  const input = openInput(handle);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('No audio track');
    const peaks = new Float32Array(PEAK_BUCKETS);
    const durationSec = Math.max(durationMs / 1000, 0.001);
    let decodedSec = 0;
    let lastReport = 0;
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples()) {
      try {
        const size = sample.allocationSize({ planeIndex: 0, format: 'f32-planar' });
        const data = new Float32Array(size / 4);
        sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
        const framesPerBucket = (durationSec * sample.sampleRate) / PEAK_BUCKETS;
        const startFrame = sample.timestamp * sample.sampleRate;
        // Sampling every few frames is plenty for a picture, and much faster on long files.
        for (let i = 0; i < data.length; i += 8) {
          const bucket = Math.min(PEAK_BUCKETS - 1, Math.max(0, Math.floor((startFrame + i) / framesPerBucket)));
          const value = Math.abs(data[i]!);
          if (value > peaks[bucket]!) peaks[bucket] = value;
        }
        decodedSec = Math.max(decodedSec, sample.timestamp + sample.duration);
        if (decodedSec - lastReport > 5) {
          lastReport = decodedSec;
          bridge.progress(jobId, Math.min(1, decodedSec / durationSec));
        }
      } finally {
        sample.close();
      }
    }
    // A perceptual curve keeps quiet speech visible next to loud peaks.
    const out = new Uint8Array(PEAK_BUCKETS);
    for (let i = 0; i < PEAK_BUCKETS; i++) out[i] = Math.round(Math.min(1, Math.sqrt(peaks[i]!)) * 255);
    return { peaks: out, decodedMs: Math.round(decodedSec * 1000) };
  } finally {
    input.dispose();
  }
}

async function convert(jobId: number, job: Extract<MediaJob, { op: 'convert' }>): Promise<{ durationMs: number }> {
  const input = openInput(job.input);
  try {
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => bridge.write(job.output, chunk.position, chunk.data),
    });
    const output = new Output({ format: outputFormat(job.container), target: new StreamTarget(writable, { chunked: true, chunkSize: 1 << 20 }) });
    const trim = job.startMs !== undefined && job.endMs !== undefined ? { start: job.startMs / 1000, end: job.endMs / 1000 } : undefined;
    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: job.transcode ? { codec: 'opus', bitrate: 96_000, forceTranscode: true } : {},
      ...(trim ? { trim } : {}),
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error('This audio cannot be converted.');
    conversion.onProgress = (progress) => bridge.progress(jobId, progress);
    await conversion.execute();
    const result = openInput(job.output);
    try {
      return { durationMs: Math.round((await result.computeDuration()) * 1000) };
    } finally {
      result.dispose();
    }
  } finally {
    input.dispose();
  }
}

async function run(id: number, job: MediaJob): Promise<unknown> {
  switch (job.op) {
    case 'probe':
      return probe(job.input);
    case 'analyze':
      return analyze(id, job.input, job.durationMs);
    case 'convert':
      return convert(id, job);
  }
}

bridge.onJob((id, job) => {
  run(id, job).then(
    (value) => bridge.done(id, value),
    (e: unknown) => bridge.fail(id, e instanceof Error ? e.message : String(e)),
  );
});
bridge.ready();
