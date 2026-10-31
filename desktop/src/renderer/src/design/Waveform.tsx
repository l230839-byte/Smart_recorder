import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatDuration } from '@shared/format';

const BAR_WIDTH = 3;
const BAR_GAP = 2;

function cssColor(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function prepare(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx?.clearRect(0, 0, width, height);
  return ctx;
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, value: number, height: number): void {
  const barHeight = Math.max(2, value * height * 0.92);
  ctx.beginPath();
  ctx.roundRect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight, 1.5);
  ctx.fill();
}

/** Keeps canvas colors in step with the light and dark themes. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTick((t) => t + 1);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return tick;
}

/** Seekable picture of a recording. Works by mouse and, as a slider, by keyboard and screen reader. */
export function Waveform({
  peaks,
  progress,
  durationMs,
  height = 72,
  markers = [],
  onSeek,
}: {
  peaks: ArrayLike<number> | null;
  progress: number;
  durationMs: number;
  height?: number;
  /** Positions from 0 to 1, such as bookmarks. */
  markers?: number[];
  onSeek?: (fraction: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { width } = useCanvasSize(canvas);
  const theme = useThemeTick();

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0) return;
    const ctx = prepare(el, width, height);
    if (!ctx) return;
    const bars = Math.max(1, Math.floor(width / (BAR_WIDTH + BAR_GAP)));
    const played = cssColor(el, '--primary');
    const rest = cssColor(el, '--border-strong');
    for (let i = 0; i < bars; i++) {
      let value = 0;
      if (peaks && peaks.length) {
        // Each bar shows the loudest moment in its slice of the recording.
        const from = Math.floor((i / bars) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length));
        for (let p = from; p < to; p++) value = Math.max(value, peaks[p]! / 255);
      }
      ctx.fillStyle = i / bars < progress ? played : rest;
      drawBar(ctx, i * (BAR_WIDTH + BAR_GAP), value, height);
    }
    ctx.fillStyle = cssColor(el, '--ember');
    for (const m of markers) {
      ctx.beginPath();
      ctx.arc(Math.min(width - 3, Math.max(3, m * width)), 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [peaks, progress, width, height, markers, theme]);

  const seekFromPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek?.(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!onSeek || durationMs <= 0) return;
    const step = 5000 / durationMs;
    const moves: Record<string, number> = { ArrowLeft: progress - step, ArrowRight: progress + step, Home: 0, End: 1 };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onSeek(Math.min(1, Math.max(0, next)));
  };

  return (
    <canvas
      ref={canvas}
      className="waveform"
      style={{ height }}
      role="slider"
      tabIndex={onSeek ? 0 : -1}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-valuetext={formatDuration(progress * durationMs)}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (!onSeek) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromPointer(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
      }}
    />
  );
}

/** Scrolling live level while recording. Newest on the right. */
export function LiveWaveform({ levels, height = 96, active }: { levels: number[]; height?: number; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { width } = useCanvasSize(canvas);
  const theme = useThemeTick();

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0) return;
    const ctx = prepare(el, width, height);
    if (!ctx) return;
    ctx.fillStyle = cssColor(el, active ? '--record' : '--border-strong');
    const bars = Math.floor(width / (BAR_WIDTH + BAR_GAP));
    for (let i = 0; i < bars; i++) {
      const value = levels[levels.length - 1 - i] ?? 0;
      drawBar(ctx, width - (i + 1) * (BAR_WIDTH + BAR_GAP), value, height);
    }
  }, [levels, width, height, active, theme]);

  return <canvas ref={canvas} className="waveform live" style={{ height }} aria-hidden />;
}
