import { useState } from 'react';
import { Folder, FolderOpen, FolderPlus, MoreVertical, Plus } from 'lucide-react';
import { plural } from '@shared/format';
import type { Collection } from '@shared/models';
import { Button, ConfirmDialog, EmptyState, Loading, Menu, PageHeader, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { CollectionPicker, collectionTree } from './CollectionPicker';

type DialogState =
  | { kind: 'create'; parent: Collection | null }
  | { kind: 'rename'; collection: Collection }
  | { kind: 'move'; collection: Collection }
  | { kind: 'delete'; collection: Collection };

function descendants(all: Collection[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

export function Collections() {
  const { go } = useRouter();
  const toast = useToast();
  const collections = useQuery(() => api.listCollections(), [], ['library']);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const list = collections.data;

  return (
    <div className="page">
      <PageHeader
        title="Collections"
        subtitle="Knowledge spaces for courses, clients, projects and research."
        actions={
          <Button variant="tonal" icon={Plus} onClick={() => setDialog({ kind: 'create', parent: null })}>
            New collection
          </Button>
        }
      />
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="Organize your knowledge"
          message="Create collections and nest them, like University → Semester 1 → Machine Learning."
          action={
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: 'create', parent: null })}>
              Create a collection
            </Button>
          }
        />
      ) : (
        <div className="rec-list">
          {collectionTree(list).map(({ collection, depth }) => (
            <div key={collection.id} className="collection-row">
              <button type="button" className="collection-open" style={{ paddingLeft: 16 + depth * 22 }} onClick={() => go({ name: 'library', collectionId: collection.id })}>
                <Folder size={18} aria-hidden />
                <span className="grow truncate">{collection.name}</span>
                <span className="muted small">{plural(collection.recordingCount, 'recording')}</span>
              </button>
              <Menu
                icon={MoreVertical}
                label={`Options for ${collection.name}`}
                items={[
                  { label: 'New sub-collection', icon: FolderPlus, onSelect: () => setDialog({ kind: 'create', parent: collection }) },
                  { label: 'Rename', onSelect: () => setDialog({ kind: 'rename', collection }) },
                  { label: 'Move', onSelect: () => setDialog({ kind: 'move', collection }) },
                  { label: 'Delete', danger: true, onSelect: () => setDialog({ kind: 'delete', collection }) },
                ]}
              />
            </div>
          ))}
        </div>
      )}

      {dialog?.kind === 'create' && (
        <TextPromptDialog
          title={dialog.parent ? `New in “${dialog.parent.name}”` : 'New collection'}
          label="Name"
          confirmLabel="Create"
          onConfirm={(name) => void api.createCollection(name, dialog.parent?.id ?? null).catch(toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <TextPromptDialog
          title="Rename collection"
          label="Name"
          initial={dialog.collection.name}
          onConfirm={(name) => void api.renameCollection(dialog.collection.id, name).catch(toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && list && (
        <CollectionPicker
          title={`Move “${dialog.collection.name}”`}
          noneLabel="Top level"
          collections={list.filter((c) => !descendants(list, dialog.collection.id).has(c.id))}
          onPick={(parentId) => void api.moveCollection(dialog.collection.id, parentId).catch(toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete “${dialog.collection.name}”?`}
          message="Recordings stay in your library. Anything inside moves up one level."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void api.deleteCollection(dialog.collection.id).catch(toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
