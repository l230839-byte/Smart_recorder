import { Folder, FolderX } from 'lucide-react';
import type { Collection } from '@shared/models';
import { Dialog } from '../../design/components';
import '../library/library.css';

/** Flattens the tree into display order with nesting depth, children under their parent. */
export function collectionTree(collections: Collection[]): { collection: Collection; depth: number }[] {
  const children = new Map<string | null, Collection[]>();
  for (const c of collections) {
    const key = c.parentId;
    children.set(key, [...(children.get(key) ?? []), c]);
  }
  const out: { collection: Collection; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of children.get(parent) ?? []) {
      out.push({ collection: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function CollectionPicker({
  title,
  collections,
  noneLabel = 'No collection',
  onPick,
  onClose,
}: {
  title: string;
  collections: Collection[];
  noneLabel?: string;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const pick = (id: string | null) => {
    onPick(id);
    onClose();
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="stack" style={{ gap: 0 }}>
        <div className="collection-row">
          <button type="button" className="collection-open" onClick={() => pick(null)}>
            <FolderX size={18} aria-hidden />
            {noneLabel}
          </button>
        </div>
        {collectionTree(collections).map(({ collection, depth }) => (
          <div key={collection.id} className="collection-row">
            <button type="button" className="collection-open" style={{ paddingLeft: 16 + depth * 20 }} onClick={() => pick(collection.id)}>
              <Folder size={18} aria-hidden />
              <span className="truncate">{collection.name}</span>
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
