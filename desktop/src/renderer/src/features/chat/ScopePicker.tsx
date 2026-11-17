import { useState } from 'react';
import type { ChatScope } from '@shared/chat';
import { formatDuration } from '@shared/format';
import { Button, Dialog, SearchField, Segmented } from '../../design/components';
import { api, useQuery } from '../../lib/api';

/** What a new chat is about: the whole library, one collection, or recordings the person picks. */
export function ScopePicker({ initial, onPick, onClose }: { initial: ChatScope; onPick: (scope: ChatScope) => void; onClose: () => void }) {
  const recordings = useQuery(() => api.listRecordings({ view: 'all', sort: 'newest' }), []);
  const collections = useQuery(() => api.listCollections(), []);
  const [kind, setKind] = useState<ChatScope['kind']>(initial.kind);
  const [collectionId, setCollectionId] = useState(initial.kind === 'collection' ? initial.collectionId : '');
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial.kind === 'recordings' ? initial.recordingIds : []));
  const [text, setText] = useState('');

  const needle = text.trim().toLowerCase();
  const shown = (recordings.data ?? []).filter((r) => !needle || r.title.toLowerCase().includes(needle));
  const valid = kind === 'library' || (kind === 'collection' ? !!collectionId : chosen.size > 0);

  const pick = () => {
    if (!valid) return;
    onPick(kind === 'library' ? { kind } : kind === 'collection' ? { kind, collectionId } : { kind, recordingIds: [...chosen] });
  };

  return (
    <Dialog title="Ask about" onClose={onClose} wide>
      <Segmented
        label="Ask about"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'library', label: 'Whole library' },
          { value: 'collection', label: 'A collection' },
          { value: 'recordings', label: 'Chosen recordings' },
        ]}
      />
      <div className="scope-body">
        {kind === 'library' && <p className="muted">Every recording with a transcript, except those in the trash. EchoMind searches them for each question and reads the best matching passages.</p>}
        {kind === 'collection' && (
          <div className="field">
            <label htmlFor="scope-collection">Collection</label>
            <select id="scope-collection" className="select" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              <option value="">Choose a collection</option>
              {collections.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="muted small">Includes its sub-collections. Good for a course, a client or a project.</p>
          </div>
        )}
        {kind === 'recordings' && (
          <>
            <SearchField value={text} onChange={setText} placeholder="Find recordings" />
            <div className="scope-list" role="group" aria-label="Recordings">
              {shown.map((r) => (
                <label key={r.id} className="scope-row">
                  <input
                    type="checkbox"
                    checked={chosen.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      setChosen(next);
                    }}
                  />
                  <span className="grow truncate" dir="auto">
                    {r.title}
                  </span>
                  <span className="muted small tabular">{r.hasTranscript ? formatDuration(r.durationMs) : 'no transcript'}</span>
                </label>
              ))}
              {!shown.length && <p className="muted small">No recordings match.</p>}
            </div>
            <p className="muted small">{chosen.size} chosen</p>
          </>
        )}
      </div>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid} onClick={pick}>
          Use this
        </Button>
      </div>
    </Dialog>
  );
}
