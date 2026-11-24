import { useState } from 'react';
import { Users } from 'lucide-react';
import { SPEAKER_MODELS } from '@shared/providers';
import { Button, Dialog } from '../../design/components';
import { api, errorMessage, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';

const TOTAL_MB = SPEAKER_MODELS.segmentation.sizeMb + SPEAKER_MODELS.voices.sizeMb;

/**
 * Labels who spoke when, on this computer. The first time, its two small models are downloaded (asking
 * first when Offline only is on, since that is the one moment it uses the network).
 */
export function SpeakersDialog({ recordingId, offlineOnly, onClose }: { recordingId: string; offlineOnly: boolean; onClose: () => void }) {
  const toast = useToast();
  const models = useQuery(() => api.listSpeakerModels(), [], ['settings']);
  const [count, setCount] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = models.data?.models.every((m) => m.installed) ?? false;
  const downloading = models.data?.models.find((m) => m.downloading)?.downloading;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!ready) await api.downloadSpeakerModels();
      const outcome = await api.requestSpeakers(recordingId, count === 'auto' ? null : Number(count));
      if (!outcome.ok) throw new Error(outcome.reason === 'needs-transcript' ? 'Transcribe this recording first.' : 'The speaker models could not be prepared. Try again.');
      toast.show('Finding speakers on this computer. The transcript updates when it is done.');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Label speakers" onClose={onClose}>
      <p>EchoMind listens for the different voices in the whole recording and labels each transcript line Speaker A, Speaker B and so on. It all happens on this computer; nothing is sent anywhere. Rename speakers afterwards in the transcript.</p>
      {models.data && !models.data.installed && <div className="notice warning">Speaker labels are not included in this copy of EchoMind. Developers: run npm run fetch:sherpa once.</div>}
      <div className="field">
        <label htmlFor="speaker-count">How many people speak?</label>
        <select id="speaker-count" className="select" value={count} onChange={(e) => setCount(e.target.value)}>
          <option value="auto">Find out automatically</option>
          {[2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={String(n)}>
              {n} people
            </option>
          ))}
        </select>
        <span className="muted small">If you know the number, choosing it gives the most accurate labels. A one-hour recording takes about a quarter of an hour on a typical computer.</span>
      </div>
      {!ready && (
        <p className="small muted">
          {downloading
            ? `Downloading the speaker models: ${Math.round(downloading.received / 1048576)} of ${Math.round(downloading.total / 1048576)} MB.`
            : `The first time, ${TOTAL_MB} MB of speaker models are downloaded from their official pages and checked.${offlineOnly ? ' Offline only is on: this is the one moment EchoMind uses the internet, and only for the models.' : ''}`}
        </p>
      )}
      {error && (
        <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" icon={Users} disabled={busy || !models.data?.installed} onClick={() => void start()}>
          {busy ? (ready ? 'Starting…' : 'Downloading…') : ready ? 'Label speakers' : `Download (${TOTAL_MB} MB) and label`}
        </Button>
      </div>
    </Dialog>
  );
}
