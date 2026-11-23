import { groupNotes, notesLength } from '@shared/summaries';

export interface NoteStore {
  get(slot: number): string | null;
  save(slot: number, text: string): void;
}

/**
 * A three-hour recording makes more notes than one request can carry, especially on free tiers that
 * limit tokens per minute. This merges neighbouring notes, round after round, until they fit `budget`.
 * The plan depends only on the notes, so each merge is saved in its own slot from `firstSlot` on: a
 * retry after a rate limit continues where it stopped instead of paying for the same merge again.
 */
export async function reduceNotes(notes: string[], budget: number, store: NoteStore, firstSlot: number, merge: (group: string[]) => Promise<string>, onMerge?: (round: number, done: number, total: number) => void): Promise<string[]> {
  let level = notes;
  let slot = firstSlot;
  for (let round = 1; level.length > 1 && notesLength(level) > budget && round <= 10; round++) {
    const groups = groupNotes(level, budget);
    const merges = groups.filter((g) => g.length > 1).length;
    const next: string[] = [];
    let done = 0;
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      let text = store.get(slot);
      if (text === null) {
        onMerge?.(round, done, merges);
        text = await merge(group);
        store.save(slot, text);
      }
      next.push(text);
      slot++;
      done++;
    }
    level = next;
  }
  return level;
}
