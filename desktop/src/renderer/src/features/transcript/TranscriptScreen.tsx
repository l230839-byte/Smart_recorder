import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Download, FileText, History, Locate, Pause, Pencil, Play, Users } from 'lucide-react';
import { formatDateTime, formatDuration } from '@shared/format';
import { PROVIDER_INFO, TRANSCRIPT_LANGUAGES, type TranscriptionProviderId } from '@shared/providers';
import { activeBlockIndex, findMatches, hasQuestions, hasSpeakers, speakerName, toBlocks, TRANSCRIPT_MODE_LABEL, TRANSCRIPT_MODES, type TranscriptBlock, type TranscriptMode } from '@shared/transcript';
import { Button, Chip, EmptyState, IconButton, Loading, Menu, PageHeader, SearchField, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player, usePlayer } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import './transcript.css';

function Highlighted({ text, query, activeOffset }: { text: string; query: string; activeOffset: number | null }): ReactNode {
  const matches = findMatches(text, query);
  if (!matches.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  matches.forEach(([start, end], i) => {
    parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className={activeOffset === i ? 'current' : ''}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  parts.push(text.slice(at));
  return parts;
}

function SegmentEditor({ text, onSave, onCancel }: { text: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  return (
    <div className="segment-editor">
      <textarea
        className="textarea"
        aria-label="Segment text"
        dir="auto"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && value.trim()) onSave(value);
        }}
      />
      <div className="row">
        <Button size="sm" variant="primary" disabled={!value.trim()} onClick={() => onSave(value)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="muted small">Ctrl+Enter saves. The original text is kept.</span>
      </div>
    </div>
  );
}

export function TranscriptScreen({ id, startMs }: { id: string; startMs?: number }) {
  const { go } = useRouter();
  const toast = useToast();
  const recording = useQuery(() => api.getRecording(id), [id], ['library']);
  const transcript = useQuery(() => api.getTranscript(id), [id], ['transcripts']);
  const playback = usePlayer();
  const [mode, setMode] = useState<TranscriptMode>('paragraph');
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const data = transcript.data;
  const rec = recording.data;
  const loaded = playback.recording?.id === id;

  useEffect(() => {
    if (rec && startMs !== undefined) void player.load(rec, startMs);
  }, [rec?.id, startMs]);

  const blocks = useMemo(() => (data ? toBlocks(mode, data.segments) : []), [data, mode]);

  /** Every match in reading order, so next and previous can step through them. */
  const allMatches = useMemo(() => {
    const out: { block: TranscriptBlock; offset: number }[] = [];
    for (const block of blocks) findMatches(block.text, query).forEach((_, offset) => out.push({ block, offset }));
    return out;
  }, [blocks, query]);

  const safeIndex = allMatches.length ? Math.min(matchIndex, allMatches.length - 1) : 0;
  const currentMatch = allMatches[safeIndex];

  const activeIdx = loaded ? activeBlockIndex(blocks, playback.positionMs) : -1;
  const activeKey = activeIdx >= 0 ? blocks[activeIdx]!.key : null;

  useEffect(() => {
    if (follow && playback.playing && activeKey && !query) blockRefs.current.get(activeKey)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeKey, follow, playback.playing, query]);

  const jumpToMatch = (index: number) => {
    if (!allMatches.length || !rec) return;
    const wrapped = (index + allMatches.length) % allMatches.length;
    setMatchIndex(wrapped);
    const match = allMatches[wrapped]!;
    blockRefs.current.get(match.block.key)?.scrollIntoView({ block: 'center' });
    void player.load(rec, match.block.startMs);
  };

  if (recording.data === null) return <EmptyState icon={FileText} title="This recording no longer exists" message="It may have been permanently deleted." />;
  if (!rec || transcript.data === undefined) return <Loading />;
  if (!data) {
    return (
      <div className="page">
        <EmptyState
          icon={FileText}
          title="No transcript yet"
          message="Create one from the recording's screen."
          action={<Button onClick={() => go({ name: 'recording', id })}>Open recording</Button>}
        />
      </div>
    );
  }

  const { version, versions, segments, speakers } = data;
  const language = TRANSCRIPT_LANGUAGES.find((l) => l.value === version.language)?.label ?? version.language;
  const providerLabel = PROVIDER_INFO[version.provider as TranscriptionProviderId]?.label ?? version.provider;
  const isDemo = version.provider === 'fake';
  const speakerLabels = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => !!s))];

  const seek = (ms: number) => {
    void player.load(rec, ms, true);
  };

  const emptyMode =
    mode === 'speaker' && !hasSpeakers(segments)
      ? `${providerLabel} does not identify speakers, so this view has nobody to separate. Other views show the full text.`
      : mode === 'qa' && !hasQuestions(segments)
        ? 'No questions were found in this transcript.'
        : null;

  return (
    <div className="page transcript-page">
      <PageHeader
        title={<span dir="auto">{rec.title}</span>}
        subtitle={[version.kind === 'edited' ? 'Edited transcript' : 'Transcript', language, providerLabel].filter(Boolean).join(' · ')}
        actions={
          <>
            <Menu
              icon={History}
              label="Versions"
              items={versions.map((v) => ({
                label: `${v.kind === 'edited' ? 'Edited' : 'Original'} · ${formatDateTime(v.createdAt)}`,
                current: v.isCurrent,
                onSelect: () => void api.setCurrentVersion(id, v.id).catch(toast.showError),
              }))}
            />
            <Menu
              icon={Download}
              label="Export transcript"
              items={(['txt', 'srt', 'vtt'] as const).map((format) => ({
                label: `Save as ${format.toUpperCase()}`,
                onSelect: () => void api.exportTranscript(id, format).then((saved) => saved && toast.show('Transcript saved'), toast.showError),
              }))}
            />
          </>
        }
      />

      {isDemo && (
        <div className="notice warning" role="status">
          This is a demo transcript with placeholder text, not your audio. Add a real provider in Settings for an actual transcript.
        </div>
      )}

      <div className="transcript-tools">
        <div className="lib-chips" role="group" aria-label="Transcript view">
          {TRANSCRIPT_MODES.map((m) => (
            <Chip key={m} selected={mode === m} onClick={() => { setMode(m); setEditing(null); }}>
              {TRANSCRIPT_MODE_LABEL[m]}
            </Chip>
          ))}
        </div>
        <div className="row">
          <SearchField
            value={query}
            onChange={(v) => {
              setQuery(v);
              setMatchIndex(0);
            }}
            placeholder="Find in transcript"
          />
          {query.trim() && (
            <>
              <span className="muted small tabular" role="status">
                {allMatches.length ? `${safeIndex + 1} of ${allMatches.length}` : 'No matches'}
              </span>
              <IconButton icon={ChevronUp} label="Previous match" disabled={!allMatches.length} onClick={() => jumpToMatch(safeIndex - 1)} />
              <IconButton icon={ChevronDown} label="Next match" disabled={!allMatches.length} onClick={() => jumpToMatch(safeIndex + 1)} />
            </>
          )}
          <IconButton icon={Locate} label={follow ? 'Stop following playback' : 'Follow playback'} active={follow} onClick={() => setFollow((v) => !v)} />
          {speakerLabels.length > 0 && (
            <Menu icon={Users} label="Rename speakers" items={speakerLabels.map((label) => ({ label: speakerName(label, speakers) ?? label, onSelect: () => setRenaming(label) }))} />
          )}
        </div>
        {mode !== 'timestamped' && <p className="muted small">To correct text, switch to the Timestamped view.</p>}
      </div>

      {emptyMode ? (
        <p className="muted">{emptyMode}</p>
      ) : (
        <div className="transcript-body">
          {blocks.map((block) => {
            const isEditing = mode === 'timestamped' && block.segmentIdx !== null && editing === block.segmentIdx;
            const who = speakerName(block.speaker, speakers);
            return (
              <div
                key={block.key}
                ref={(el) => {
                  if (el) blockRefs.current.set(block.key, el);
                  else blockRefs.current.delete(block.key);
                }}
                className={`t-block ${block.key === activeKey ? 'active' : ''} ${block.kind}`}
              >
                <div className="t-gutter">
                  {(block.showTime || mode === 'speaker' || mode === 'paragraph') && (
                    <button type="button" className="t-time tabular" aria-label={`Play from ${formatDuration(block.startMs)}`} onClick={() => seek(block.startMs)}>
                      {formatDuration(block.startMs)}
                    </button>
                  )}
                </div>
                <div className="t-main">
                  {who && mode !== 'raw' && mode !== 'cleaned' && <div className="t-speaker">{who}</div>}
                  {block.kind === 'question' && <div className="t-kind">Question</div>}
                  {isEditing ? (
                    <SegmentEditor
                      text={block.text}
                      onCancel={() => setEditing(null)}
                      onSave={(text) => {
                        setEditing(null);
                        void api.editSegment(id, block.segmentIdx!, text).catch(toast.showError);
                      }}
                    />
                  ) : (
                    <p className={`t-text selectable ${block.uncertain ? 'uncertain' : ''}`} dir="auto" title={block.uncertain ? 'The service was unsure about this part' : undefined}>
                      <Highlighted text={block.text} query={query} activeOffset={currentMatch?.block.key === block.key ? currentMatch.offset : null} />
                    </p>
                  )}
                </div>
                <div className="t-actions">
                  <IconButton icon={loaded && playback.playing && block.key === activeKey ? Pause : Play} size={15} label={`Play from ${formatDuration(block.startMs)}`} onClick={() => (loaded && playback.playing && block.key === activeKey ? player.toggle() : seek(block.startMs))} />
                  {mode === 'timestamped' && block.segmentIdx !== null && !isEditing && <IconButton icon={Pencil} size={15} label={`Edit text at ${formatDuration(block.startMs)}`} onClick={() => setEditing(block.segmentIdx)} />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {renaming && (
        <TextPromptDialog
          title="Rename speaker"
          label="Name"
          initial={speakerName(renaming, speakers) ?? ''}
          onConfirm={(name) => void api.renameSpeaker(id, renaming, name).catch(toast.showError)}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
