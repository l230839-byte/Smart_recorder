import { FileUp, Mic } from 'lucide-react';
import { formatBytes, formatDurationLong } from '@shared/format';
import { Button, Card, EmptyState, PageHeader, SectionTitle } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { RecordingRow } from '../library/RecordingRow';
import '../library/library.css';

const RECENT_COUNT = 5;

function greeting(name: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

export function Home() {
  const { switchTo, go } = useRouter();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const stats = useQuery(() => api.getLibraryStats(), [], ['library']);
  const recent = useQuery(() => api.listRecordings({ view: 'all', sort: 'newest' }), [], ['library']);

  return (
    <div className="page">
      <PageHeader title={greeting(settings.data?.displayName ?? '')} subtitle="Turn every recording into knowledge, documents and action." />

      <div className="home-actions">
        <button type="button" className="home-action primary" onClick={() => switchTo({ name: 'record' })}>
          <span className="home-action-icon">
            <Mic size={22} aria-hidden />
          </span>
          <span>
            <h2>Record</h2>
            <span className="muted small">Lecture, meeting, notes and more</span>
          </span>
        </button>
        <button type="button" className="home-action" onClick={() => go({ name: 'import' })}>
          <span className="home-action-icon">
            <FileUp size={22} aria-hidden />
          </span>
          <span>
            <h2>Import</h2>
            <span className="muted small">Voice notes, recorder files, video</span>
          </span>
        </button>
      </div>

      {!!stats.data?.recordings && (
        <div className="stat-grid">
          <Card>
            <div className="stat-value tabular">{stats.data.recordings}</div>
            <div className="muted small">{stats.data.recordings === 1 ? 'Recording' : 'Recordings'}</div>
          </Card>
          <Card>
            <div className="stat-value">{formatDurationLong(stats.data.totalDurationMs)}</div>
            <div className="muted small">Captured</div>
          </Card>
          <Card>
            <div className="stat-value">{formatBytes(stats.data.totalBytes)}</div>
            <div className="muted small">On this computer</div>
          </Card>
        </div>
      )}

      {recent.data &&
        (recent.data.length === 0 ? (
          <EmptyState icon={Mic} title="Nothing here yet" message="Record something or import a file. It will show up here, ready to use." />
        ) : (
          <section>
            <SectionTitle
              title="Recent"
              action={
                <Button size="sm" variant="ghost" onClick={() => switchTo({ name: 'library' })}>
                  See all
                </Button>
              }
            />
            <div className="rec-list">
              {recent.data.slice(0, RECENT_COUNT).map((r) => (
                <RecordingRow key={r.id} recording={r} onOpen={() => go({ name: 'recording', id: r.id })} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
