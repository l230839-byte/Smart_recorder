import { useEffect, useRef, useState } from 'react';
import { MessagesSquare, Search as SearchIcon } from 'lucide-react';
import { formatDateTime, formatDuration, plural } from '@shared/format';
import { MODE_INFO, type RecordingMode } from '@shared/models';
import { SEARCH_KIND_LABEL, snippetParts, type SearchHit, type SearchKind, type SearchQuery } from '@shared/search';
import { Button, EmptyState, Loading, PageHeader } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import './chat.css';

const PERIODS = { any: 'Any time', week: 'Past week', month: 'Past month', year: 'Past year' } as const;
type Period = keyof typeof PERIODS;
const PERIOD_DAYS: Record<Exclude<Period, 'any'>, number> = { week: 7, month: 31, year: 366 };

function Snippet({ text }: { text: string }) {
  return (
    <span className="snippet selectable" dir="auto">
      {snippetParts(text).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

/**
 * One search across names, transcripts, chapters, speakers, summaries and documents (prompt §12, §15.3),
 * with snippets and times. Matching words are highlighted from plain data, never HTML.
 */
export function SearchScreen({ text: initial = '' }: { text?: string }) {
  const { go, replace } = useRouter();
  const [text, setText] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  const [kind, setKind] = useState<SearchKind | ''>('');
  const [collectionId, setCollectionId] = useState('');
  const [period, setPeriod] = useState<Period>('any');
  const input = useRef<HTMLInputElement>(null);
  const collections = useQuery(() => api.listCollections(), [], ['library']);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(text);
      // Kept in the route, so coming Back from a result shows the same search.
      replace({ name: 'search', text });
    }, 200);
    return () => clearTimeout(timer);
  }, [text, replace]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const query: SearchQuery = {
    text: debounced,
    ...(kind ? { kind } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(period !== 'any' ? { from: Date.now() - PERIOD_DAYS[period] * 86_400_000 } : {}),
  };
  const results = useQuery(() => (debounced.trim() ? api.searchEverything(query) : Promise.resolve(null)), [debounced, kind, collectionId, period], ['library', 'transcripts', 'summaries', 'documents']);

  const open = (recordingId: string, hit: SearchHit) => {
    if (hit.kind === 'transcript' || hit.kind === 'chapter') go({ name: 'transcript', id: recordingId, startMs: hit.startMs ?? 0 });
    else if (hit.kind === 'summary') go({ name: 'summaries', id: recordingId });
    else if (hit.kind === 'document' && hit.targetId) go({ name: 'document', id: hit.targetId });
    else go({ name: 'recording', id: recordingId });
  };

  const list = results.data;
  return (
    <div className="page">
      <PageHeader title="Search" subtitle="Names, transcripts, chapters, speakers, summaries and documents, all at once." />
      <div className="search-big">
        <SearchIcon size={18} aria-hidden />
        <input ref={input} className="input" type="search" aria-label="Search everything" placeholder="Search everything, in any language" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="row wrap search-filters">
        <select className="select" aria-label="Kind of content" value={kind} onChange={(e) => setKind(e.target.value as SearchKind | '')}>
          <option value="">Everything</option>
          {(Object.keys(SEARCH_KIND_LABEL) as SearchKind[]).map((k) => (
            <option key={k} value={k}>
              {k === 'title' ? 'Names, tags and notes' : `${SEARCH_KIND_LABEL[k]}s`}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
          <option value="">All collections</option>
          {collections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="When" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          {Object.entries(PERIODS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="grow" />
        {!!list?.length && (
          <Button icon={MessagesSquare} onClick={() => go({ name: 'chat', scope: { kind: 'recordings', recordingIds: list.slice(0, 20).map((r) => r.recordingId) } })}>
            Ask AI about {list.length > 20 ? 'the top 20' : plural(list.length, 'result')}
          </Button>
        )}
      </div>

      {!debounced.trim() ? (
        <EmptyState icon={SearchIcon} title="Search your whole library" message="Find a word in any transcript and jump straight to that moment. Words in Urdu and English both work. Press Ctrl+K anywhere to come here." />
      ) : results.error ? (
        <p className="notice error">{results.error}</p>
      ) : !list ? (
        <Loading />
      ) : !list.length ? (
        <EmptyState icon={SearchIcon} title="Nothing found" message={`No recording mentions “${debounced.trim()}”${kind || collectionId || period !== 'any' ? ' with these filters' : ''}. Try fewer or different words, or ask AI, which can find related ideas.`} />
      ) : (
        <div className="search-results" aria-live="polite">
          <p className="muted small">{plural(list.length, 'recording')}</p>
          {list.map((r) => (
            <article key={r.recordingId} className="search-result card">
              <button type="button" className="result-head" onClick={() => go({ name: 'recording', id: r.recordingId })}>
                <span className="result-title truncate" dir="auto">
                  {r.title}
                </span>
                <span className="muted small">
                  {MODE_INFO[r.mode as RecordingMode]?.label ?? r.mode} · {formatDateTime(r.createdAt)} · {formatDuration(r.durationMs)}
                </span>
              </button>
              <ul className="hit-list">
                {r.hits.map((h, i) => (
                  <li key={i}>
                    <button type="button" className="hit" onClick={() => open(r.recordingId, h)}>
                      <span className={`hit-kind kind-${h.kind}`}>{SEARCH_KIND_LABEL[h.kind]}</span>
                      {h.startMs !== null && <span className="cite tabular">{formatDuration(h.startMs)}</span>}
                      {h.label && h.kind !== 'chapter' && (
                        <span className="hit-label truncate" dir="auto">
                          {h.label}:
                        </span>
                      )}
                      <Snippet text={h.snippet} />
                    </button>
                  </li>
                ))}
              </ul>
              {r.totalHits > r.hits.length && <p className="muted small more-hits">{plural(r.totalHits - r.hits.length, 'more match', 'more matches')}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
