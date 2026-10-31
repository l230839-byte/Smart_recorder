import { useEffect, useMemo } from 'react';
import { Bookmark, FileAudio, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { formatDuration } from '@shared/format';
import { MODE_INFO } from '@shared/models';
import { Button, Card, Chip, EmptyState, IconButton, Loading, SwitchRow } from '../../design/components';
import { Waveform } from '../../design/Waveform';
import { api, useQuery } from '../../lib/api';
import { player, usePlayer } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { ModeBadge } from './RecordingRow';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

export function PlayerScreen({ id }: { id: string }) {
  const { back } = useRouter();
  const query = useQuery(() => api.getRecording(id), [id], ['library']);
  const bookmarks = useQuery(() => api.listBookmarks(id), [id], ['library']);
  const state = usePlayer();
  const recording = query.data;

  useEffect(() => {
    if (recording) void player.load(recording);
  }, [recording?.id]);

  const markers = useMemo(() => (bookmarks.data ?? []).map((b) => b.positionMs / Math.max(1, recording?.durationMs ?? 1)), [bookmarks.data, recording?.durationMs]);

  if (query.data === null) {
    return (
      <div className="page">
        <EmptyState icon={FileAudio} title="This recording no longer exists" message="It may have been permanently deleted." action={<Button onClick={back}>Go back</Button>} />
      </div>
    );
  }
  if (!recording) return <Loading />;

  const loaded = state.recording?.id === id;
  const duration = loaded ? state.durationMs : recording.durationMs;
  const position = loaded ? state.positionMs : 0;

  return (
    <div className="page player-screen">
      <header className="detail-head">
        <ModeBadge recording={recording} size={56} />
        <div className="grow">
          <h1 dir="auto">{recording.title}</h1>
          <div className="muted">{MODE_INFO[recording.mode].label}</div>
        </div>
      </header>

      <Card>
        <Waveform peaks={state.peaks} progress={duration > 0 ? position / duration : 0} durationMs={duration} height={140} markers={markers} onSeek={(f) => player.seek(f * duration)} />
        <div className="time-row tabular">
          <span>{formatDuration(position)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </Card>

      <div className="player-big-controls">
        <IconButton icon={RotateCcw} label="Back 10 seconds" size={24} onClick={() => player.skip(-10_000)} />
        <button type="button" className="play-btn large" aria-label={state.playing ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
          {state.playing ? <Pause size={30} aria-hidden /> : <Play size={30} aria-hidden />}
        </button>
        <IconButton icon={RotateCw} label="Forward 10 seconds" size={24} onClick={() => player.skip(10_000)} />
      </div>

      {state.error && <div className="notice error">{state.error}</div>}

      <section className="stack">
        <h2>Speed</h2>
        <div className="lib-chips" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <Chip key={s} selected={state.speed === s} onClick={() => player.setSpeed(s)}>
              {s}×
            </Chip>
          ))}
        </div>
      </section>

      <Card>
        <SwitchRow title="Skip silence" subtitle="Jumps over quiet stretches longer than a second and a half" checked={state.skipSilence} onChange={(v) => player.setSkipSilence(v)} />
        <SwitchRow title="Voice boost" subtitle="Makes quiet speech louder during playback. The file is not changed." checked={state.voiceBoost} onChange={(v) => player.setVoiceBoost(v)} />
      </Card>

      {!!bookmarks.data?.length && (
        <section className="stack">
          <h2>Bookmarks</h2>
          <div className="lib-chips">
            {bookmarks.data.map((b) => (
              <button key={b.id} type="button" className="chip" onClick={() => player.seek(b.positionMs)}>
                <Bookmark size={13} aria-hidden style={{ color: 'var(--ember)' }} />
                <span className="tabular">{formatDuration(b.positionMs)}</span> {b.note ?? b.label}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
