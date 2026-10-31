import { useEffect, useState } from 'react';
import { Bookmark, BookOpen, Briefcase, Check, CircleAlert, Circle, GraduationCap, Mic, MicOff, NotebookPen, Pause, Play, Sparkles, Square, Trash2, Users } from 'lucide-react';
import { formatDuration, plural } from '@shared/format';
import { AUDIO_QUALITY, MODE_INFO, RECORDING_MODES, type AudioQuality, type RecordingMode } from '@shared/models';
import { Button, Card, ConfirmDialog, Dialog, Loading, PageHeader, Segmented, type IconType } from '../../design/components';
import { LiveWaveform } from '../../design/Waveform';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { recorder, useRecorder } from '../../lib/recorder';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import './record.css';

export const MODE_ICON: Record<RecordingMode, IconType> = {
  lecture: GraduationCap,
  meeting: Users,
  interview: Mic,
  notes: NotebookPen,
  business: Briefcase,
  journal: BookOpen,
  custom: Sparkles,
};

const QUALITY_OPTIONS = (Object.keys(AUDIO_QUALITY) as AudioQuality[]).map((value) => ({ value, label: AUDIO_QUALITY[value].label }));

function ModeSelection() {
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const { error, warning, status, lastSavedId } = useRecorder();
  const { go } = useRouter();
  const [mode, setMode] = useState<RecordingMode | null>(null);
  const [title, setTitle] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const load = () => void navigator.mediaDevices.enumerateDevices().then((list) => setDevices(list.filter((d) => d.kind === 'audioinput')));
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);

  if (!settings.data) return <Loading />;
  const s = settings.data;
  const selected = mode ?? s.defaultMode;
  const quality = AUDIO_QUALITY[s.audioQuality];

  const start = () => {
    // Otherwise the speakers would be recorded through the microphone.
    if (player.state.playing) player.toggle();
    void api.updateSettings({ defaultMode: selected });
    void recorder.start(title.trim() || `${MODE_INFO[selected].label} recording`, selected, s);
  };

  return (
    <div className="page">
      <PageHeader title="Record" subtitle="Choose a mode. It shapes how AI organizes this recording later." />

      {error && (
        <div className="notice error" role="alert">
          <CircleAlert size={18} aria-hidden />
          <span className="grow">{error}</span>
        </div>
      )}
      {warning && !error && (
        <div className="notice warning" role="status">
          <CircleAlert size={18} aria-hidden />
          <span className="grow">{warning}</span>
          {lastSavedId && (
            <Button size="sm" onClick={() => go({ name: 'recording', id: lastSavedId })}>
              Open
            </Button>
          )}
        </div>
      )}

      <div className="mode-grid" role="radiogroup" aria-label="Recording mode">
        {RECORDING_MODES.map((m) => {
          const Icon = MODE_ICON[m];
          return (
            <button key={m} type="button" className="mode-card" role="radio" aria-checked={selected === m} onClick={() => setMode(m)}>
              <span className="mode-icon">
                <Icon size={20} aria-hidden />
              </span>
              <span className="mode-text">
                <h3>{MODE_INFO[m].label}</h3>
                <span className="muted small">{MODE_INFO[m].hint}</span>
              </span>
              {selected === m && <Check size={18} aria-hidden className="mode-check" />}
            </button>
          );
        })}
      </div>

      <Card className="record-panel">
        <div className="field grow">
          <label htmlFor="rec-title">Title (optional)</label>
          <input id="rec-title" className="input" placeholder={`${MODE_INFO[selected].label} recording`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field record-mic">
          <label htmlFor="rec-mic">Microphone</label>
          <select
            id="rec-mic"
            className="select"
            value={s.inputDeviceId ?? ''}
            onChange={(e) => void api.updateSettings({ inputDeviceId: e.target.value || null })}
          >
            <option value="">System default</option>
            {devices
              .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label">Quality</span>
          <Segmented label="Recording quality" options={QUALITY_OPTIONS} value={s.audioQuality} onChange={(audioQuality) => void api.updateSettings({ audioQuality })} />
        </div>
        <div className="record-start">
          <span className="muted small">{quality.hint}</span>
          <Button variant="record" size="lg" icon={Circle} onClick={start} disabled={status === 'starting'}>
            {status === 'starting' ? 'Starting…' : 'Start recording'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ActiveRecording() {
  const state = useRecorder();
  const { go, switchTo } = useRouter();
  const toast = useToast();
  const [note, setNote] = useState<{ atMs: number; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const paused = state.status === 'paused';
  const saving = state.status === 'saving';

  const addBookmark = () => {
    if (saving) return;
    recorder.bookmark(recorder.elapsed(), 'Bookmark', null);
    toast.show(`Bookmarked at ${formatDuration(recorder.elapsed())}`);
  };

  const stop = () => {
    void recorder.stop().then((id) => {
      if (id) switchTo({ name: 'library' });
      if (id) go({ name: 'recording', id });
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('dialog')) return;
      if (e.key.toLowerCase() === 'b') addBookmark();
      if (e.key.toLowerCase() === 'n') setNote({ atMs: recorder.elapsed(), text: '' });
      if (e.key === ' ' && target.tagName !== 'BUTTON') {
        e.preventDefault();
        if (paused) recorder.resume();
        else recorder.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="page record-active">
      <div className="record-status" aria-live="polite">
        <span className={`record-dot ${paused ? 'paused' : ''}`} aria-hidden />
        <span>{saving ? 'Saving…' : paused ? 'Paused' : 'Recording'}</span>
        <span className="badge">{MODE_INFO[state.mode].label}</span>
      </div>

      <input
        className="record-title-input"
        aria-label="Recording title"
        value={state.title}
        maxLength={200}
        onChange={(e) => recorder.setDetails({ title: e.target.value })}
      />

      <div className="record-timer tabular" role="timer" aria-label="Elapsed time">
        {formatDuration(state.elapsedMs)}
      </div>

      <LiveWaveform levels={state.levels} active={!paused} />

      {state.warning && (
        <div className="notice warning" role="status">
          {state.warning.startsWith('No sound') ? <MicOff size={18} aria-hidden /> : <CircleAlert size={18} aria-hidden />}
          <span className="grow">{state.warning}</span>
        </div>
      )}

      <div className="record-controls">
        {paused ? (
          <Button size="lg" variant="tonal" icon={Play} onClick={() => recorder.resume()} disabled={saving}>
            Resume
          </Button>
        ) : (
          <Button size="lg" variant="tonal" icon={Pause} onClick={() => recorder.pause()} disabled={saving}>
            Pause
          </Button>
        )}
        <Button size="lg" variant="record" icon={Square} onClick={stop} disabled={saving}>
          Stop and save
        </Button>
      </div>

      <div className="record-secondary">
        <Button icon={Bookmark} onClick={addBookmark} disabled={saving} title="Shortcut: B">
          Bookmark
        </Button>
        <Button icon={NotebookPen} onClick={() => setNote({ atMs: recorder.elapsed(), text: '' })} disabled={saving} title="Shortcut: N">
          Add note
        </Button>
        <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDiscard(true)} disabled={saving}>
          Discard
        </Button>
      </div>

      <textarea
        className="textarea record-description"
        aria-label="Description"
        dir="auto"
        placeholder="Add a description (optional)"
        rows={2}
        value={state.description}
        onChange={(e) => recorder.setDetails({ description: e.target.value })}
      />

      <div className="muted small record-help">
        {state.bookmarkCount > 0 ? `${plural(state.bookmarkCount, 'bookmark')} so far. ` : ''}
        You can use other screens while recording. Audio is saved to disk every second.
      </div>

      {note && (
        <Dialog title={`Note at ${formatDuration(note.atMs)}`} onClose={() => setNote(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              // The note belongs to the moment it was started, not when typing finished.
              recorder.bookmark(note.atMs, 'Note', note.text);
              setNote(null);
            }}
          >
            <textarea className="textarea" aria-label="Note" autoFocus value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
            <div className="dialog-actions">
              <Button variant="ghost" onClick={() => setNote(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={!note.text.trim()}>
                Save note
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this recording?"
          message="The audio captured so far will be permanently deleted."
          confirmLabel="Discard"
          destructive
          onConfirm={() => void recorder.discard()}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}

export function RecordScreen() {
  const { status } = useRecorder();
  return status === 'idle' || status === 'starting' ? <ModeSelection /> : <ActiveRecording />;
}
