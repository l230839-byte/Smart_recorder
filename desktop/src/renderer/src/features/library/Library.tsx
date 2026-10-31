import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDownUp, CheckSquare, Folder, FolderInput, FolderTree, Import, LibraryBig, RotateCcw, Star, StarOff, Trash2, X } from 'lucide-react';
import { plural } from '@shared/format';
import { LIBRARY_SORT_LABEL, LIBRARY_SORTS, LIBRARY_VIEW_LABEL, LIBRARY_VIEWS, type LibrarySort, type LibraryView } from '@shared/models';
import { Button, Chip, ConfirmDialog, EmptyState, IconButton, Loading, Menu, PageHeader, SearchField } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { CollectionPicker } from '../collections/CollectionPicker';
import { RecordingRow } from './RecordingRow';

interface ViewMemory {
  view: LibraryView;
  sort: LibrarySort;
  text: string;
  tagId: string | null;
  scrollTop: number;
}

/**
 * Opening a recording unmounts this screen, and coming back must not lose the user's place. Kept per
 * collection for the session; there is no reason to store it on disk.
 */
const memory = new Map<string, ViewMemory>();

export function Library({ collectionId }: { collectionId?: string }) {
  const { go } = useRouter();
  const toast = useToast();
  const remembered = memory.get(collectionId ?? '');
  const [view, setView] = useState<LibraryView>(remembered?.view ?? 'all');
  const [sort, setSort] = useState<LibrarySort>(remembered?.sort ?? 'newest');
  const [text, setText] = useState(remembered?.text ?? '');
  const [debounced, setDebounced] = useState(remembered?.text ?? '');
  const [tagId, setTagId] = useState<string | null>(remembered?.tagId ?? null);
  const root = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(false);
  const latest = useRef({ view, sort, text, tagId });
  latest.current = { view, sort, text, tagId };
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'empty' | 'move' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inTrash = view === 'trash';

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(timer);
  }, [text]);

  const recordings = useQuery(
    () => api.listRecordings({ view, sort, text: debounced, tagId, collectionId }),
    [view, sort, debounced, tagId, collectionId],
    ['library'],
  );
  const tags = useQuery(() => api.listTags(inTrash), [inTrash], ['library']);
  const collections = useQuery(() => api.listCollections(), [], ['library']);
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const collection = useMemo(() => collections.data?.find((c) => c.id === collectionId), [collections.data, collectionId]);
  const list = recordings.data;
  const selected = useMemo(() => [...(selection ?? [])], [selection]);

  useLayoutEffect(() => {
    const scroller = root.current?.closest('.content');
    return () => {
      memory.set(collectionId ?? '', { ...latest.current, scrollTop: scroller?.scrollTop ?? 0 });
    };
  }, [collectionId]);

  useLayoutEffect(() => {
    if (!list || scrollRestored.current) return;
    scrollRestored.current = true;
    const scroller = root.current?.closest('.content');
    if (scroller && remembered?.scrollTop) scroller.scrollTop = remembered.scrollTop;
  }, [list, remembered?.scrollTop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const changeView = (next: LibraryView) => {
    // Trash and the live library offer different tags; a hidden active filter could not be cleared.
    if ((next === 'trash') !== inTrash) setTagId(null);
    setView(next);
    setSelection(null);
  };

  const toggle = (id: string) => {
    setSelection((s) => {
      const next = new Set(s ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const act = (work: Promise<unknown>, message?: string) => {
    work.then(() => {
      setSelection(null);
      if (message) toast.show(message);
    }, toast.showError);
  };

  const trashSelected = () => {
    player.closeIfLoaded(selected);
    const ids = selected;
    act(api.trashRecordings(ids), undefined);
    toast.show(`Moved ${plural(ids.length, 'recording')} to trash`, { label: 'Undo', run: () => void api.restoreRecordings(ids) });
  };

  const allFavorite = !!list && selected.length > 0 && selected.every((id) => list.find((r) => r.id === id)?.favorite);

  return (
    <div className="page" ref={root}>
      <PageHeader
        title={collection ? collection.name : 'Library'}
        subtitle={list ? plural(list.length, 'recording') : undefined}
        actions={
          <>
            <IconButton icon={CheckSquare} label="Select" active={selection !== null} onClick={() => setSelection((s) => (s ? null : new Set()))} />
            <IconButton icon={FolderTree} label="Collections" onClick={() => go({ name: 'collections' })} />
            <Menu
              icon={ArrowDownUp}
              label="Sort"
              items={LIBRARY_SORTS.map((s) => ({ label: LIBRARY_SORT_LABEL[s], current: s === sort, onSelect: () => setSort(s) }))}
            />
            <Button variant="tonal" icon={Import} onClick={() => go({ name: 'import' })}>
              Import
            </Button>
          </>
        }
      />

      <div className="lib-filters">
        <SearchField value={text} onChange={setText} placeholder="Search titles, descriptions, tags and notes (Ctrl+F)" inputRef={searchRef} />
        <div className="lib-chips" role="group" aria-label="Filter">
          {LIBRARY_VIEWS.map((v) => (
            <Chip key={v} selected={view === v} onClick={() => changeView(v)}>
              {LIBRARY_VIEW_LABEL[v]}
            </Chip>
          ))}
        </div>
        {!!tags.data?.length && (
          <div className="lib-chips" role="group" aria-label="Tags">
            {tags.data.map((t) => (
              <Chip key={t.id} selected={tagId === t.id} onClick={() => setTagId(tagId === t.id ? null : t.id)}>
                #{t.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {inTrash && !!list?.length && (
        <div className="trash-note">
          <span className="muted small">Removed permanently after {settings.data?.trashRetentionDays ?? 30} days.</span>
          <Button size="sm" variant="danger" onClick={() => setDialog('empty')}>
            Empty trash
          </Button>
        </div>
      )}

      {recordings.error ? (
        <EmptyState icon={LibraryBig} title="The library could not be loaded" message={recordings.error} action={<Button onClick={recordings.reload}>Try again</Button>} />
      ) : !list ? (
        <Loading />
      ) : list.length === 0 ? (
        inTrash ? (
          <EmptyState icon={Trash2} title="Trash is empty" message={`Deleted recordings stay here for ${settings.data?.trashRetentionDays ?? 30} days, then are removed permanently.`} />
        ) : text.trim() || tagId || view !== 'all' ? (
          <EmptyState icon={LibraryBig} title="Nothing matches" message="Try another word or filter." />
        ) : collection ? (
          <EmptyState icon={Folder} title="This collection is empty" message="Select recordings in the Library and move them here." />
        ) : (
          <EmptyState
            icon={LibraryBig}
            title="Your library is empty"
            message="Recordings you make or import will appear here, all with the same tools."
            action={
              <Button variant="primary" icon={Import} onClick={() => go({ name: 'import' })}>
                Import audio
              </Button>
            }
          />
        )
      ) : (
        <div className="rec-list">
          {list.map((r) => (
            <RecordingRow
              key={r.id}
              recording={r}
              selecting={selection !== null}
              selected={selection?.has(r.id)}
              onToggle={() => toggle(r.id)}
              onOpen={() => go({ name: 'recording', id: r.id })}
            />
          ))}
        </div>
      )}

      {selection && selection.size > 0 && (
        <div className="batch-bar" role="toolbar" aria-label="Selected recordings">
          <strong>{selection.size} selected</strong>
          <span className="grow" />
          {inTrash ? (
            <>
              <Button size="sm" icon={RotateCcw} onClick={() => act(api.restoreRecordings(selected))}>
                Restore
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDialog('delete')}>
                Delete forever
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" icon={allFavorite ? StarOff : Star} onClick={() => act(api.setFavorite(selected, !allFavorite))}>
                {allFavorite ? 'Remove favorite' : 'Favorite'}
              </Button>
              <Button size="sm" icon={FolderInput} onClick={() => setDialog('move')}>
                Move
              </Button>
              <Button size="sm" icon={view === 'archived' ? ArchiveRestore : Archive} onClick={() => act(api.setArchived(selected, view !== 'archived'))}>
                {view === 'archived' ? 'Unarchive' : 'Archive'}
              </Button>
              <Button size="sm" icon={Trash2} onClick={trashSelected}>
                Trash
              </Button>
            </>
          )}
          <IconButton icon={X} label="Clear selection" onClick={() => setSelection(null)} />
        </div>
      )}

      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${plural(selected.length, 'recording')} forever?`}
          message="The audio and everything derived from it will be permanently removed from this computer."
          confirmLabel="Delete forever"
          destructive
          onConfirm={() => act(api.deleteForever(selected))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'empty' && (
        <ConfirmDialog
          title="Empty trash?"
          message={`${plural(list?.length ?? 0, 'recording')} will be permanently removed from this computer.`}
          confirmLabel="Empty trash"
          destructive
          onConfirm={() => act(api.emptyTrash())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'move' && (
        <CollectionPicker
          title={`Move ${plural(selected.length, 'recording')}`}
          collections={collections.data ?? []}
          onPick={(id) => act(api.moveToCollection(selected, id))}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
