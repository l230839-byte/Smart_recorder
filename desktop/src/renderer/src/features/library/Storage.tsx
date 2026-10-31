import { useState } from 'react';
import { formatBytes, plural } from '@shared/format';
import { Button, Card, ConfirmDialog, Loading, PageHeader, SectionTitle } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { RecordingRow } from './RecordingRow';

const RETENTION = [7, 30, 90, 365];

export function Storage() {
  const { go } = useRouter();
  const toast = useToast();
  const info = useQuery(() => api.getStorageInfo(), [], ['library']);
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const [confirm, setConfirm] = useState(false);
  if (!info.data || !settings.data) return <Loading />;
  const s = info.data;
  const liveBytes = s.mediaBytes - s.trashBytes;
  const total = Math.max(1, s.mediaBytes + s.freeBytes);

  return (
    <div className="page settings">
      <PageHeader title="Storage" subtitle="Audio lives in your data folder on this computer." />
      <Card>
        <div className="row">
          <strong className="grow">{formatBytes(s.mediaBytes)} used by EchoMind</strong>
          <span className="muted small">{formatBytes(s.freeBytes)} free on this disk</span>
        </div>
        <div className="usage-bar" role="img" aria-label={`${formatBytes(s.mediaBytes)} used, ${formatBytes(s.freeBytes)} free`}>
          <div className="usage-media" style={{ width: `${Math.max(liveBytes ? 0.5 : 0, (liveBytes / total) * 100)}%` }} />
          <div className="usage-trash" style={{ width: `${Math.max(s.trashBytes ? 0.5 : 0, (s.trashBytes / total) * 100)}%` }} />
        </div>
        <div className="row wrap small muted">
          <span>
            <span className="legend-dot usage-media" />
            Library {formatBytes(liveBytes)}
          </span>
          <span style={{ marginLeft: 12 }}>
            <span className="legend-dot usage-trash" />
            Trash {formatBytes(s.trashBytes)}
          </span>
        </div>
      </Card>

      <section className="stack">
        <h2>Trash</h2>
        <Card>
          <div className="setting-line">
            <label className="grow" htmlFor="retention">
              Keep deleted recordings for
            </label>
            <select id="retention" className="select setting-select" value={settings.data.trashRetentionDays} onChange={(e) => void api.updateSettings({ trashRetentionDays: Number(e.target.value) })}>
              {RETENTION.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </div>
          <div className="setting-line">
            <div className="grow">
              {plural(s.trashCount, 'recording')} in trash
              <div className="muted small">Frees {formatBytes(s.trashBytes)}.</div>
            </div>
            <Button variant="danger" disabled={s.trashCount === 0} onClick={() => setConfirm(true)}>
              Empty trash
            </Button>
          </div>
        </Card>
      </section>

      {s.largest.length > 0 && (
        <section>
          <SectionTitle title="Largest recordings" />
          <div className="rec-list">
            {s.largest.map((r) => (
              <div key={r.id} className="row" style={{ paddingRight: 'var(--s4)' }}>
                <div className="grow">
                  <RecordingRow recording={r} onOpen={() => go({ name: 'recording', id: r.id })} />
                </div>
                <span className="muted small">{formatBytes(r.sizeBytes)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {confirm && (
        <ConfirmDialog
          title="Empty trash?"
          message={`${plural(s.trashCount, 'recording')} will be permanently removed from this computer.`}
          confirmLabel="Empty trash"
          destructive
          onConfirm={() => void api.emptyTrash().catch(toast.showError)}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
