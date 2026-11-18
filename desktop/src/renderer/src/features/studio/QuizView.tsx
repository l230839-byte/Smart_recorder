import { useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { formatDateTime, formatDuration } from '@shared/format';
import { QUESTION_TYPES, scoreQuiz, type QuizAnswer, type QuizQuestion } from '@shared/studio';
import { Button } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';

/**
 * Taking a quiz. Multiple choice and true or false are marked automatically; written answers are compared
 * with the model answer and marked by the learner. Every attempt is saved (prompt §13).
 */
export function QuizView({ outputId, questions, onPlay }: { outputId: string; questions: QuizQuestion[]; onPlay: (ms: number, recordingId: string) => void }) {
  const toast = useToast();
  const attempts = useQuery(() => api.listQuizAttempts(outputId), [outputId], ['studio']);
  const [answers, setAnswers] = useState<QuizAnswer[]>(() => questions.map(() => ({ given: '', selfMarked: null })));
  const [checked, setChecked] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (i: number, patch: Partial<QuizAnswer>) => setAnswers(answers.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const result = scoreQuiz(questions, answers);
  const written = questions.map((q, i) => (q.type === 'short' || q.type === 'long' ? i : -1)).filter((i) => i >= 0);
  const unmarked = written.filter((i) => answers[i]!.selfMarked === null).length;
  const unanswered = questions.filter((q, i) => (q.type === 'mcq' || q.type === 'tf') && !answers[i]!.given).length;

  const save = () => {
    void api.saveQuizAttempt(outputId, answers).then(
      (a) => {
        setSaved(true);
        toast.show(`Saved: ${a.score} of ${a.total}`);
      },
      toast.showError,
    );
  };

  const reset = () => {
    setAnswers(questions.map(() => ({ given: '', selfMarked: null })));
    setChecked(false);
    setSaved(false);
  };

  return (
    <div className="quiz">
      {!!attempts.data?.length && (
        <p className="muted small">
          Earlier attempts: {attempts.data.slice(0, 5).map((a) => `${a.score}/${a.total} (${formatDateTime(a.createdAt)})`).join(', ')}
        </p>
      )}
      <ol className="quiz-list">
        {questions.map((q, i) => {
          const a = answers[i]!;
          const auto = q.type === 'mcq' || q.type === 'tf';
          const right = checked && result.correct[i];
          const choices = q.type === 'tf' ? ['True', 'False'] : q.options;
          return (
            <li key={i} className={`quiz-q ${checked ? (right ? 'right' : auto || a.selfMarked !== null ? 'wrong' : '') : ''}`}>
              <div className="quiz-head">
                <span className="badge">{QUESTION_TYPES[q.type]}</span>
                {checked && auto && (right ? <Check size={16} aria-label="Correct" className="ok" /> : <X size={16} aria-label="Wrong" className="bad" />)}
              </div>
              <p className="quiz-text" dir="auto">
                {q.question}
              </p>
              {auto ? (
                <div className="quiz-options" role="radiogroup" aria-label={`Answer to question ${i + 1}`}>
                  {choices.map((c, j) => (
                    <label key={j} className={`quiz-option ${checked && c === q.answer ? 'is-answer' : ''} ${checked && a.given === c && c !== q.answer ? 'is-wrong' : ''}`}>
                      <input type="radio" name={`q${i}`} disabled={checked} checked={a.given === c} onChange={() => set(i, { given: c })} />
                      <span dir="auto">{c}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <textarea className="textarea" dir="auto" aria-label={`Your answer to question ${i + 1}`} disabled={checked} value={a.given} onChange={(e) => set(i, { given: e.target.value })} />
              )}
              {checked && (
                <div className="quiz-feedback">
                  {!auto && (
                    <>
                      <p className="small">
                        <strong>Model answer:</strong> <span dir="auto">{q.answer}</span>
                      </p>
                      <div className="row small">
                        <span>Was yours right?</span>
                        <Button size="sm" variant={a.selfMarked === true ? 'tonal' : 'ghost'} icon={Check} disabled={saved} onClick={() => set(i, { selfMarked: true })}>
                          Yes
                        </Button>
                        <Button size="sm" variant={a.selfMarked === false ? 'tonal' : 'ghost'} icon={X} disabled={saved} onClick={() => set(i, { selfMarked: false })}>
                          No
                        </Button>
                      </div>
                    </>
                  )}
                  {q.explanation && (
                    <p className="small" dir="auto">
                      {q.explanation}
                      {q.explanationSupplemental && <span className="badge badge-warning"> AI explanation, beyond the recording</span>}
                    </p>
                  )}
                  {q.source && (
                    <button type="button" className="cite tabular" aria-label={`Play source at ${formatDuration(q.source.startMs)}`} onClick={() => onPlay(q.source!.startMs, q.source!.recordingId)}>
                      {formatDuration(q.source.startMs)}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="quiz-bar">
        {!checked ? (
          <>
            <span className="muted small grow">{unanswered ? `${unanswered} not answered yet` : 'All answered'}</span>
            <Button variant="primary" onClick={() => setChecked(true)}>
              Check answers
            </Button>
          </>
        ) : (
          <>
            <strong className="grow" role="status">
              Score: {result.score} of {result.total}
              {unmarked ? ` (mark ${unmarked} written ${unmarked === 1 ? 'answer' : 'answers'} to finish)` : ''}
            </strong>
            {!saved && (
              <Button variant="primary" disabled={unmarked > 0} onClick={save}>
                Save attempt
              </Button>
            )}
            <Button icon={RotateCcw} onClick={reset}>
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
