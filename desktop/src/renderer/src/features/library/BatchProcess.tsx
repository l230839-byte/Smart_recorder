import { useState } from 'react';
import { plural } from '@shared/format';
import type { Recording } from '@shared/models';
import { DEFAULT_STUDIO_OPTIONS, STUDIO_KINDS, type StudioKind } from '@shared/studio';
import { optionsForMode } from '@shared/summaries';
import { Button, Dialog } from '../../design/components';
import { api } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useTranscribe } from '../transcript/ai-gate';
import '../studio/studio.css';

type Choice = 'summary' | Extract<StudioKind, 'study' | 'flashcards' | 'quiz' | 'tasks'>;

const CHOICES: { value: Choice; label: string; hint: string; combinable: boolean }[] = [
  { value: 'summary', label: 'Summary', hint: "In the style that suits each recording's mode", combinable: false },
  { value: 'study', label: 'Study guide', hint: 'What to learn, key terms and a self-check', combinable: true },
  { value: 'flashcards', label: 'Flashcards', hint: '15 cards', combinable: true },
  { value: 'quiz', label: 'Quiz', hint: '10 mixed questions', combinable: true },
  { value: 'tasks', label: 'Action items', hint: 'Found tasks wait for your review', combinable: false },
];

/**
 * Workflow D (prompt §17): several recordings, one template, each processed in the queue with its own
 * progress and retry, as separate results or one combined result.
 */
export function BatchProcess({ recordings, onClose }: { recordings: Recording[]; onClose: () => void }) {
  const { go } = useRouter();
  const toast = useToast();
  const { startText, dialogs } = useTranscribe();
  const [choice, setChoice] = useState<Choice>('summary');
  const [combined, setCombined] = useState(false);
  const ready = recordings.filter((r) => r.hasTranscript);
  const skipped = recordings.length - ready.length;
  const option = CHOICES.find((c) => c.value === choice)!;
  const canCombine = option.combinable && ready.length > 1 && ready.length <= STUDIO_KINDS[choice as StudioKind].maxRecordings;

  const run = () => {
    // Remembers what has started, so clearing a consent or setup prompt continues instead of repeating.
    const started = new Set<string>();
    let combinedId: string | null = null;
    startText(
      async () => {
        if (combined && canCombine) {
          const out = await api.startStudio({ kind: choice as StudioKind, recordingIds: ready.map((r) => r.id), options: { ...DEFAULT_STUDIO_OPTIONS, count: choice === 'quiz' ? 10 : 15 } });
          if (out.ok) combinedId = out.outputId;
          return out.ok ? { ok: true as const } : out;
        }
        for (const r of ready) {
          if (started.has(r.id)) continue;
          const out =
            choice === 'summary'
              ? await api.requestSummary(r.id, optionsForMode(r.mode))
              : await api.startStudio({ kind: choice, recordingIds: [r.id], options: { ...DEFAULT_STUDIO_OPTIONS, count: choice === 'quiz' ? 10 : 15 } });
          if (!out.ok) return out;
          started.add(r.id);
        }
        return { ok: true as const };
      },
      () => {
        onClose();
        if (combinedId) go({ name: 'studio-output', id: combinedId });
        else toast.show(`${plural(started.size, 'recording')} added to the queue`, { label: 'View progress', run: () => go({ name: 'jobs' }) });
      },
    );
  };

  return (
    <Dialog title={`Process ${plural(recordings.length, 'recording')}`} onClose={onClose}>
      <div className="stack">
        <div className="tool-list" role="radiogroup" aria-label="What to make">
          {CHOICES.map((c) => (
            <label key={c.value} className="tool-row">
              <input type="radio" name="batch-choice" checked={choice === c.value} onChange={() => setChoice(c.value)} />
              <span className="grow">
                <strong>{c.label}</strong>
                <span className="muted small"> · {c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {canCombine && (
          <label className="row small">
            <input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} />
            One combined result from all of them, instead of one each
          </label>
        )}
        {skipped > 0 && <p className="muted small">{plural(skipped, 'recording has', 'recordings have')} no transcript yet and will be skipped. Transcribe them first.</p>}
        <p className="muted small">Each one runs in the queue with its own progress, waits out rate limits, and can be retried if it fails. Results are saved with their recordings.</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready.length} onClick={run}>
            Start
          </Button>
        </div>
      </div>
      {dialogs}
    </Dialog>
  );
}
