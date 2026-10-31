import { Check, Star } from 'lucide-react';
import { formatDuration, formatRelative } from '@shared/format';
import { MODE_INFO, SOURCE_LABEL, type Recording } from '@shared/models';
import { MODE_ICON } from '../record/RecordScreen';
import './library.css';

export function ModeBadge({ recording, size = 40 }: { recording: Pick<Recording, 'mode'>; size?: number }) {
  const Icon = MODE_ICON[recording.mode];
  return (
    <span className={`mode-badge mode-${recording.mode}`} style={{ width: size, height: size }} title={MODE_INFO[recording.mode].label}>
      <Icon size={Math.round(size * 0.48)} aria-hidden />
    </span>
  );
}

/** One line per recording, used everywhere. The same look for every source is deliberate (prompt §3). */
export function RecordingRow({
  recording,
  onOpen,
  selecting,
  selected,
  onToggle,
}: {
  recording: Recording;
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
  onToggle?: (additive: boolean) => void;
}) {
  const imported = recording.source !== 'native';
  return (
    <div className={`rec-row ${selected ? 'selected' : ''}`}>
      {onToggle && (
        <button
          type="button"
          className={`rec-check ${selecting ? 'visible' : ''}`}
          role="checkbox"
          aria-checked={!!selected}
          aria-label={`Select ${recording.title}`}
          onClick={() => onToggle(true)}
        >
          {selected && <Check size={14} aria-hidden />}
        </button>
      )}
      <button
        type="button"
        className="rec-main"
        onClick={(e) => {
          if (onToggle && (selecting || e.ctrlKey || e.shiftKey)) onToggle(true);
          else onOpen();
        }}
      >
        <ModeBadge recording={recording} />
        <span className="rec-text">
          <span className="rec-title truncate" dir="auto">
            {recording.title}
          </span>
          <span className="rec-meta">
            <span className="tabular">{formatDuration(recording.durationMs)}</span>
            <span aria-hidden>·</span>
            <span>{formatRelative(recording.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{MODE_INFO[recording.mode].label}</span>
            {imported && <span className="badge">{SOURCE_LABEL[recording.source]}</span>}
            {recording.hasTranscript && <span className="badge badge-teal">Transcript</span>}
            {recording.tags.slice(0, 3).map((t) => (
              <span key={t.id} className="rec-tag">
                #{t.name}
              </span>
            ))}
            {recording.tags.length > 3 && <span className="rec-tag">+{recording.tags.length - 3}</span>}
          </span>
        </span>
        {recording.favorite && <Star size={16} className="rec-star" aria-label="Favorite" fill="currentColor" />}
      </button>
    </div>
  );
}
