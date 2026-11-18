import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCcw, Shuffle, X } from 'lucide-react';
import { formatDuration } from '@shared/format';
import type { Flashcard } from '@shared/studio';
import { Button, IconButton } from '../../design/components';

/** Cards to study: flip, mark known or still learning, and go round again with the ones still to learn. */
export function FlashcardsView({ cards, onPlay }: { cards: Flashcard[]; onPlay: (ms: number, recordingId: string) => void }) {
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [at, setAt] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'study' | 'list'>('study');
  const done = at >= order.length;
  const card = done ? null : cards[order[at]!]!;

  const next = useCallback(
    (result?: 'known' | 'learning') => {
      if (done) return;
      if (result) {
        const k = new Set(known);
        if (result === 'known') k.add(order[at]!);
        else k.delete(order[at]!);
        setKnown(k);
      }
      setFlipped(false);
      setAt((a) => a + 1);
    },
    [done, known, order, at],
  );

  // Space flips; arrows and K / L move on, so studying needs no mouse.
  useEffect(() => {
    if (mode !== 'study') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'k') next('known');
      else if (e.key.toLowerCase() === 'l') next('learning');
      else if (e.key === 'ArrowLeft') {
        setFlipped(false);
        setAt((a) => Math.max(0, a - 1));
      }
    };
    // Capture phase, so this runs before the app-wide Space-to-play shortcut, which then stands aside.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, next]);

  const again = (onlyLearning: boolean) => {
    const rest = cards.map((_, i) => i).filter((i) => !onlyLearning || !known.has(i));
    setOrder(rest.length ? rest : cards.map((_, i) => i));
    setAt(0);
    setFlipped(false);
  };

  return (
    <div className="flashcards">
      <div className="row">
        <Button size="sm" variant={mode === 'study' ? 'tonal' : 'ghost'} onClick={() => setMode('study')}>
          Study
        </Button>
        <Button size="sm" variant={mode === 'list' ? 'tonal' : 'ghost'} onClick={() => setMode('list')}>
          All cards ({cards.length})
        </Button>
        <span className="grow" />
        {mode === 'study' && (
          <span className="muted small">
            {Math.min(at + 1, order.length)} of {order.length} · {known.size} known
          </span>
        )}
      </div>

      {mode === 'list' ? (
        <ol className="card-list">
          {cards.map((c, i) => (
            <li key={i}>
              <div className="card-q" dir="auto">
                {c.front}
              </div>
              <div className="card-a selectable" dir="auto">
                {c.back}
              </div>
              <CardMeta card={c} onPlay={onPlay} />
            </li>
          ))}
        </ol>
      ) : done ? (
        <div className="study-done">
          <h2>
            You know {known.size} of {cards.length}
          </h2>
          <div className="row">
            {known.size < cards.length && (
              <Button variant="primary" icon={RotateCcw} onClick={() => again(true)}>
                Study the {cards.length - known.size} still to learn
              </Button>
            )}
            <Button icon={RotateCcw} onClick={() => again(false)}>
              Start over
            </Button>
          </div>
        </div>
      ) : (
        card && (
          <>
            <button type="button" className={`flip-card ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped((f) => !f)} aria-label={flipped ? 'Show question' : 'Show answer'}>
              <span className="flip-side-label">{flipped ? 'Answer' : 'Question'}</span>
              <span className="flip-text selectable" dir="auto">
                {flipped ? card.back : card.front}
              </span>
              {!flipped && <span className="muted small">Select or press Space to see the answer</span>}
            </button>
            {flipped && <CardMeta card={card} onPlay={onPlay} />}
            <div className="row study-controls">
              <IconButton icon={ChevronLeft} label="Previous (Left arrow)" disabled={at === 0} onClick={() => (setFlipped(false), setAt((a) => a - 1))} />
              <span className="grow" />
              <Button icon={X} onClick={() => next('learning')}>
                Still learning (L)
              </Button>
              <Button variant="primary" icon={Check} onClick={() => next('known')}>
                I knew it (K)
              </Button>
              <span className="grow" />
              <IconButton
                icon={Shuffle}
                label="Shuffle"
                onClick={() => {
                  setOrder([...order].sort(() => Math.random() - 0.5));
                  setAt(0);
                  setFlipped(false);
                }}
              />
              <IconButton icon={ChevronRight} label="Skip (Right arrow)" onClick={() => next()} />
            </div>
          </>
        )
      )}
    </div>
  );
}

function CardMeta({ card, onPlay }: { card: Flashcard; onPlay: (ms: number, recordingId: string) => void }) {
  return (
    <div className="card-meta">
      {card.source && (
        <button type="button" className="cite tabular" aria-label={`Play source at ${formatDuration(card.source.startMs)}`} onClick={() => onPlay(card.source!.startMs, card.source!.recordingId)}>
          {formatDuration(card.source.startMs)}
        </button>
      )}
      {card.supplemental && <span className="badge badge-warning">AI explanation, beyond the recording</span>}
    </div>
  );
}
