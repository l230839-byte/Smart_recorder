import { useEffect, useState } from 'react';
import { FileUp, Loader2, Pause, Play, X } from 'lucide-react';
import { formatDuration, plural } from '@shared/format';
import { IconButton } from '../design/components';
import { Waveform } from '../design/Waveform';
import { api, onEvent, useQuery } from '../lib/api';
import { player, usePlayer } from '../lib/player';
import { recorder, useRecorder } from '../lib/recorder';
import { useRouter } from '../lib/router';
import { useToast } from '../lib/toast';

/** Bottom bar that keeps playback reachable on every screen. */
export function MiniPlayer() {
  const state = usePlayer();
  const { route, go } = useRouter();
  const { recording } = state;
  if (!recording) return null;
  // The full player and this recording's own screen already show these controls.
  if ((route.name === 'player' || route.name === 'recording') && route.id === recording.id) return null;
  const duration = state.durationMs;
  return (
    <div className="mini-player" role="region" aria-label="Now playing">
      <div className="row">
        <button type="button" className="play-btn" aria-label={state.playing ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
          {state.playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        </button>
        <button type="button" className="mini-title grow" onClick={() => go({ name: 'recording', id: recording.id })}>
          <div className="truncate" dir="auto">
            {recording.title}
          </div>
          <div className="muted small tabular">
            {formatDuration(state.positionMs)} / {formatDuration(duration)}
          </div>
        </button>
      </div>
      <Waveform peaks={state.peaks} progress={duration > 0 ? state.positionMs / duration : 0} durationMs={duration} height={36} onSeek={(f) => player.seek(f * duration)} />
      <IconButton icon={X} label="Close player" onClick={() => player.close()} />
    </div>
  );
}

/** Always visible while recording, on every screen: recording is never hidden (prompt §21). */
export function RecordingIndicator() {
  const state = useRecorder();
  const { section, switchTo, go } = useRouter();
  const jobs = useQuery(() => api.listJobs(), [], ['jobs']);
  const activeJobs = jobs.data?.filter((j) => ['queued', 'running', 'waiting'].includes(j.status)).length ?? 0;
  const recording = state.status !== 'idle' && state.status !== 'starting';
  if (!recording && activeJobs === 0) return null;
  return (
    <div className="stack" style={{ marginTop: 'auto', gap: 'var(--s2)' }}>
      {activeJobs > 0 && (
        <button type="button" className="job-pill" onClick={() => go({ name: 'jobs' })}>
          <Loader2 size={14} aria-hidden className="spin" />
          {plural(activeJobs, 'job')} processing
        </button>
      )}
      {recording && (
      <button type="button" className="rec-pill" aria-label={`Recording, ${formatDuration(state.elapsedMs)}. Open recorder`} onClick={() => section !== 'record' && switchTo({ name: 'record' })}>
        <span className={`record-dot ${state.status === 'paused' ? 'paused' : ''}`} aria-hidden />
        <span className="grow tabular" style={{ textAlign: 'left' }}>
          {state.status === 'saving' ? 'Saving…' : state.status === 'paused' ? `Paused ${formatDuration(state.elapsedMs)}` : formatDuration(state.elapsedMs)}
        </span>
      </button>
      )}
    </div>
  );
}

/** Dropping files anywhere imports them: the desktop counterpart of "Share to EchoMind". */
export function DropTarget() {
  const [dragging, setDragging] = useState(false);
  const { go, route } = useRouter();
  const toast = useToast();

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.echomind.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      void api
        .getSettings()
        .then((s) => api.importPaths(paths, s.defaultMode))
        .then(() => {
          if (route.name !== 'import') go({ name: 'import' });
        })
        .catch(toast.showError);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [go, route.name, toast]);

  if (!dragging) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <FileUp size={36} />
      Drop to import
    </div>
  );
}

/** Reacts to things that happen outside any one screen. */
export function GlobalEvents() {
  const { go, route } = useRouter();
  const toast = useToast();
  const { warning, error, lastSavedId, status } = useRecorder();

  useEffect(() => onEvent('imports:opened', () => go({ name: 'import' })), [go]);
  useEffect(() => onEvent('recording:open', (id) => go({ name: 'recording', id })), [go]);

  // Space controls playback, as in other media apps, unless the user is typing or pressing a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || recorder.isActive || !player.state.recording) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, button, [role=slider], dialog')) return;
      e.preventDefault();
      player.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(
    () =>
      onEvent('recordings:recovered', (count) => {
        toast.show(`Recovered ${plural(count, 'interrupted recording')}. Nothing was lost.`);
      }),
    [toast],
  );

  useEffect(
    () =>
      onEvent('recorder:stop-and-quit', () => {
        void recorder.stop().finally(() => window.echomind.closeAfterRecording());
      }),
    [],
  );

  // A stop the user did not ask for (unplugged mic, full disk) must be seen on whatever screen is open.
  useEffect(() => {
    if (route.name === 'record' || status !== 'idle') return;
    if (error) toast.showError(new Error(error));
    else if (warning) toast.show(warning, lastSavedId ? { label: 'Open', run: () => go({ name: 'recording', id: lastSavedId }) } : undefined);
    if (error || warning) recorder.dismissMessages();
  }, [error, warning, lastSavedId, status, route.name, toast, go]);

  return null;
}

