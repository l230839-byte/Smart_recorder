import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Bookmark, Download, FileAudio, FolderInput, Maximize2, MoreVertical, Pause, Pencil, Play, Plus, RotateCcw, Scissors, Star, Trash2, X } from 'lucide-react';
import { formatBytes, formatDateTime, formatDuration } from '@shared/format';
import { clampPosition } from '@shared/media';
import { MODE_INFO, RECORDING_MODES, SOURCE_LABEL, type Recording, type RecordingMode } from '@shared/models';
import { Button, Card, ConfirmDialog, Dialog, EmptyState, IconButton, Loading, Menu, SectionTitle, TextPromptDialog } from '../../design/components';
import { Waveform } from '../../design/Waveform';
import { api, useQuery } from '../../lib/api';
import { player, usePlayer } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { CollectionPicker } from '../collections/CollectionPicker';
import { AiCard } from '../transcript/AiCard';
import { ModeBadge } from './RecordingRow';

const MIN_TRIM_CUT_MS = 500;
const MIN_TRIM_KEEP_MS = 1000;

function EditDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(recording.title);
  const [description, setDescription] = useState(recording.description);
  const [mode, setMode] = useState<RecordingMode>(recording.mode);
  return (
    <Dialog title="Edit details" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api.updateRecording(recording.id, { title: title.trim(), description: description.trim(), mode }).then(onClose, toast.showError);
        }}
      >
        <div className="field">
          <label htmlFor="edit-title">Title</label>
          <input id="edit-title" className="input" dir="auto" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-desc">Description</label>
          <textarea id="edit-desc" className="textarea" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-mode">Recording mode</label>
          <select id="edit-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as RecordingMode)}>
            {RECORDING_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_INFO[m].label}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TrimDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const { go } = useRouter();
  const toast = useToast();
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(recording.durationMs);
  const [busy, setBusy] = useState(false);
  const keptMs = endMs - startMs;
  // Keeping everything would only duplicate the recording under a misleading "(trimmed)" title.
  const cutsSomething = recording.durationMs - keptMs >= MIN_TRIM_CUT_MS;
  const valid = cutsSomething && keptMs >= MIN_TRIM_KEEP_MS;

  const create = () => {
    setBusy(true);
    api.trimRecording(recording.id, startMs, endMs).then(
      (id) => {
        onClose();
        toast.show('Trimmed copy created. The original is unchanged.');
        go({ name: 'recording', id });
      },
      (e: unknown) => {
        setBusy(false);
        toast.showError(e);
      },
    );
  };

  return (
    <Dialog title="Trim into new recording" onClose={onClose}>
      <p className="muted">Choose the part to keep. A new recording is created and the original stays unchanged.</p>
      <div className="field">
        <label htmlFor="trim-start">Start: {formatDuration(startMs)}</label>
        <input id="trim-start" type="range" min={0} max={recording.durationMs} step={100} value={startMs} onChange={(e) => setStartMs(Math.min(Number(e.target.value), endMs))} />
      </div>
      <div className="field">
        <label htmlFor="trim-end">End: {formatDuration(endMs)}</label>
        <input id="trim-end" type="range" min={0} max={recording.durationMs} step={100} value={endMs} onChange={(e) => setEndMs(Math.max(Number(e.target.value), startMs))} />
      </div>
      <p>
        <strong className="tabular">Keeping {formatDuration(keptMs)}</strong>
        {!cutsSomething && <span className="muted small"> · Move a slider to choose a shorter part.</span>}
      </p>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={create} disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </Dialog>
  );
}

type DialogKind = 'edit' | 'trim' | 'tag' | 'move' | 'delete' | 'bookmark';

export function RecordingDetail({ id, startMs }: { id: string; startMs?: number }) {
  const { go, back } = useRouter();
  const toast = useToast();
  const query = useQuery(() => api.getRecording(id), [id], ['library']);
  const bookmarks = useQuery(() => api.listBookmarks(id), [id], ['library']);
  const collections = useQuery(() => api.listCollections(), [], ['library']);
  const peaks = useQuery(() => api.getPeaks(id), [id]);
  const playback = usePlayer();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [noteAt, setNoteAt] = useState(0);
  const recording = query.data;
  const loaded = playback.recording?.id === id;

  useEffect(() => {
    if (recording) player.refresh(recording);
  }, [recording]);

  useEffect(() => {
    if (recording && startMs !== undefined) void player.load(recording, startMs);
    // Only for a deep link's first open.
  }, [recording?.id, startMs]);

  if (query.data === null) {
    return (
      <div className="page">
        <EmptyState icon={FileAudio} title="This recording no longer exists" message="It may have been permanently deleted." action={<Button onClick={back}>Go back</Button>} />
      </div>
    );
  }
  if (!recording) return <Loading />;

  const inTrash = recording.deletedAt !== null;
  const positionMs = loaded ? playback.positionMs : 0;
  const durationMs = loaded ? playback.durationMs : recording.durationMs;
  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  const collection = collections.data?.find((c) => c.id === recording.collectionId);
  const markers = (bookmarks.data ?? []).map((b) => b.positionMs / Math.max(1, recording.durationMs));

  const togglePlay = () => {
    if (loaded) player.toggle();
    else void player.load(recording, undefined, true);
  };
  const seekTo = (ms: number) => void player.load(recording, ms);
  const trash = () => {
    player.closeIfLoaded([id]);
    api.trashRecordings([id]).then(() => {
      toast.show('Moved to trash', { label: 'Undo', run: () => void api.restoreRecordings([id]) });
      back();
    }, toast.showError);
  };

  return (
    <div className="page">
      <header className="detail-head">
        <ModeBadge recording={recording} size={48} />
        <div className="grow">
          <h1 className="selectable" dir="auto">
            {recording.title}
          </h1>
          <div className="muted">
            {MODE_INFO[recording.mode].label} · {formatDateTime(recording.createdAt)}
          </div>
        </div>
        <IconButton icon={Star} label={recording.favorite ? 'Remove from favorites' : 'Add to favorites'} active={recording.favorite} onClick={() => void api.setFavorite([id], !recording.favorite)} />
        <IconButton icon={Pencil} label="Edit details" onClick={() => setDialog('edit')} />
        <Menu
          icon={MoreVertical}
          label="More actions"
          items={[
            { label: 'Trim into new recording', icon: Scissors, onSelect: () => setDialog('trim') },
            { label: 'Save a copy of the audio', icon: Download, onSelect: () => void api.exportAudio(id).then((saved) => saved && toast.show('Audio saved'), toast.showError) },
            { label: 'Move to collection', icon: FolderInput, onSelect: () => setDialog('move') },
            recording.archived
              ? { label: 'Unarchive', icon: ArchiveRestore, onSelect: () => void api.setArchived([id], false) }
              : { label: 'Archive', icon: Archive, onSelect: () => void api.setArchived([id], true) },
            inTrash
              ? { label: 'Delete forever', icon: Trash2, danger: true, onSelect: () => setDialog('delete') }
              : { label: 'Move to trash', icon: Trash2, danger: true, onSelect: trash },
          ]}
        />
      </header>

      {inTrash && (
        <div className="notice error" role="status">
          <span className="grow">
            <strong>This recording is in the trash.</strong> Restore it to use AI features.
          </span>
          <Button size="sm" icon={RotateCcw} onClick={() => void api.restoreRecordings([id])}>
            Restore
          </Button>
        </div>
      )}

      {recording.description && (
        <p className="selectable" dir="auto">
          {recording.description}
        </p>
      )}

      <div className="detail-grid">
        <div className="stack" style={{ gap: 'var(--s5)' }}>
          <Card>
            <Waveform peaks={peaks.data ?? null} progress={progress} durationMs={durationMs} markers={markers} onSeek={(f) => seekTo(f * durationMs)} />
            <div className="player-controls">
              <button type="button" className="play-btn" aria-label={loaded && playback.playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                {loaded && playback.playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
              </button>
              <span className="grow tabular">
                {formatDuration(positionMs)} / {formatDuration(durationMs)}
              </span>
              <IconButton
                icon={Bookmark}
                label="Bookmark current position"
                onClick={() => {
                  setNoteAt(clampPosition(positionMs, recording.durationMs));
                  setDialog('bookmark');
                }}
              />
              <IconButton icon={Maximize2} label="Open full player" onClick={() => go({ name: 'player', id })} />
            </div>
            {loaded && playback.error && <p className="small" style={{ color: 'var(--danger)' }}>{playback.error}</p>}
          </Card>

          {!inTrash && <AiCard recording={recording} />}

          <section>
            <SectionTitle
              title="Bookmarks and notes"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Plus}
                  onClick={() => {
                    setNoteAt(clampPosition(positionMs, recording.durationMs));
                    setDialog('bookmark');
                  }}
                >
                  Add
                </Button>
              }
            />
            <Card>
              {!bookmarks.data?.length ? (
                <p className="muted small">Mark important moments while recording or listening. Select one to jump there.</p>
              ) : (
                bookmarks.data.map((b) => (
                  <div key={b.id} className="bookmark-row">
                    <button type="button" className="bookmark-jump" onClick={() => seekTo(b.positionMs)}>
                      <Bookmark size={15} aria-hidden fill="currentColor" />
                      <span className="bookmark-time tabular">{formatDuration(b.positionMs)}</span>
                      <span className="bookmark-text selectable" dir="auto">
                        {b.note ?? b.label}
                      </span>
                    </button>
                    <IconButton icon={Trash2} label="Delete bookmark" size={15} onClick={() => void api.deleteBookmark(b.id)} />
                  </div>
                ))
              )}
            </Card>
          </section>
        </div>

        <aside className="stack" style={{ gap: 'var(--s5)' }}>
          <section>
            <SectionTitle
              title="Tags"
              action={
                <Button size="sm" variant="ghost" icon={Plus} onClick={() => setDialog('tag')}>
                  Add
                </Button>
              }
            />
            <Card>
              {recording.tags.length === 0 ? (
                <p className="muted small">No tags yet. Tags make recordings easier to find.</p>
              ) : (
                <div className="tag-list">
                  {recording.tags.map((t) => (
                    <span key={t.id} className="tag-chip">
                      #{t.name}
                      <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => void api.removeTag(id, t.id)}>
                        <X size={13} aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </section>

          <section>
            <SectionTitle title="Details" />
            <Card>
              <dl className="detail-table">
                <dt>Source</dt>
                <dd>{SOURCE_LABEL[recording.source]}</dd>
                {recording.originalName && (
                  <>
                    <dt>File</dt>
                    <dd dir="auto">{recording.originalName}</dd>
                  </>
                )}
                <dt>Duration</dt>
                <dd className="tabular">{formatDuration(recording.durationMs)}</dd>
                <dt>Size</dt>
                <dd>{formatBytes(recording.sizeBytes)}</dd>
                <dt>Format</dt>
                <dd>
                  {recording.format}
                  {recording.codec && recording.codec !== recording.format ? ` · ${recording.codec}` : ''}
                </dd>
                {recording.sampleRate > 0 && (
                  <>
                    <dt>Audio</dt>
                    <dd>
                      {(recording.sampleRate / 1000).toFixed(1)} kHz · {recording.channels === 1 ? 'Mono' : recording.channels === 2 ? 'Stereo' : `${recording.channels} channels`}
                    </dd>
                  </>
                )}
                <dt>Collection</dt>
                <dd>{collection?.name ?? 'None'}</dd>
                {recording.importedAt && (
                  <>
                    <dt>Imported</dt>
                    <dd>{formatDateTime(recording.importedAt)}</dd>
                  </>
                )}
              </dl>
            </Card>
          </section>
        </aside>
      </div>

      {dialog === 'edit' && <EditDialog recording={recording} onClose={() => setDialog(null)} />}
      {dialog === 'trim' && <TrimDialog recording={recording} onClose={() => setDialog(null)} />}
      {dialog === 'tag' && (
        <TextPromptDialog title="Add tag" label="Tag" confirmLabel="Add" onConfirm={(name) => void api.addTag(id, name).catch(toast.showError)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'bookmark' && (
        <TextPromptDialog
          title={`Bookmark at ${formatDuration(noteAt)}`}
          label="Note (optional)"
          multiline
          confirmLabel="Save"
          onConfirm={(note) => void api.addBookmark(id, noteAt, note ? 'Note' : 'Bookmark', note || null).catch(toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'move' && (
        <CollectionPicker title="Move to collection" collections={collections.data ?? []} onPick={(cid) => void api.moveToCollection([id], cid).catch(toast.showError)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title="Delete forever?"
          message="The audio and everything derived from it will be permanently removed from this computer."
          confirmLabel="Delete forever"
          destructive
          onConfirm={() => {
            player.closeIfLoaded([id]);
            api.deleteForever([id]).then(back, toast.showError);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
