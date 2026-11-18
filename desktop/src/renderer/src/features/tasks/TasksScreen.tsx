import { useId, useState } from 'react';
import { Bell, Check, CheckCheck, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { formatDateTime, formatDuration } from '@shared/format';
import type { Task, TaskEdit, TaskStatus } from '@shared/studio';
import { Button, ConfirmDialog, Dialog, EmptyState, IconButton, Loading, Menu, PageHeader, SearchField, Segmented } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import './tasks.css';

type View = 'suggested' | 'open' | 'done';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dueLabel(task: Task): { text: string; tone: 'overdue' | 'today' | '' } | null {
  if (!task.dueDate) return task.dueText ? { text: task.dueText, tone: '' } : null;
  const t = today();
  const date = new Date(`${task.dueDate}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: task.dueDate.slice(0, 4) === t.slice(0, 4) ? undefined : 'numeric' });
  if (task.status === 'open' && task.dueDate < t) return { text: `Overdue · ${date}`, tone: 'overdue' };
  if (task.dueDate === t) return { text: 'Due today', tone: 'today' };
  return { text: `Due ${date}`, tone: '' };
}

/** "datetime-local" values are local time without a zone; these convert both ways. */
const toLocalInput = (ms: number | null) => {
  if (ms === null) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function EditDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const toast = useToast();
  const id = useId();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [owner, setOwner] = useState(task?.owner ?? '');
  const [priority, setPriority] = useState<Task['priority']>(task?.priority ?? null);
  const [remind, setRemind] = useState(toLocalInput(task?.remindAt ?? null));

  const save = async () => {
    // Editing a found task is how it is corrected before approval, so saving approves it.
    const edit: TaskEdit = { title, description, dueDate: dueDate || null, owner, priority, remindAt: remind ? new Date(remind).getTime() : null, ...(task?.status === 'suggested' ? { status: 'open' as const } : {}) };
    if (task) await api.updateTask(task.id, edit);
    else {
      const created = await api.createTask({ title, description, dueDate: dueDate || null });
      await api.updateTask(created, edit);
    }
  };

  return (
    <Dialog title={!task ? 'New task' : task.status === 'suggested' ? 'Edit and approve' : 'Edit task'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save().then(onClose, toast.showError);
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-t`}>Task</label>
          <input id={`${id}-t`} className="input" dir="auto" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-d`}>Details</label>
          <textarea id={`${id}-d`} className="textarea" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="row wrap">
          <div className="field grow">
            <label htmlFor={`${id}-due`}>Due</label>
            <input id={`${id}-due`} className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor={`${id}-who`}>Who</label>
            <input id={`${id}-who`} className="input" dir="auto" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </div>
        </div>
        <div className="row wrap">
          <div className="field grow">
            <label htmlFor={`${id}-p`}>Priority</label>
            <select id={`${id}-p`} className="select" value={priority ?? ''} onChange={(e) => setPriority((e.target.value || null) as Task['priority'])}>
              <option value="">Not set</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="field grow">
            <label htmlFor={`${id}-r`}>Remind me</label>
            <input id={`${id}-r`} className="input" type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} />
          </div>
        </div>
        <p className="muted small">Reminders appear as Windows notifications while EchoMind is open. Nothing is added to a calendar or sent to anyone.</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TaskRow({ task, onEdit, onDelete }: { task: Task; onEdit: () => void; onDelete: () => void }) {
  const toast = useToast();
  const { go } = useRouter();
  const due = dueLabel(task);
  const set = (edit: TaskEdit) => void api.updateTask(task.id, edit).catch(toast.showError);
  const playSource = () =>
    void api
      .getRecording(task.recordingId!)
      .then((rec) => rec && player.load(rec, task.startMs ?? 0, true))
      .catch(toast.showError);

  return (
    <li className={`task-row ${task.status}`}>
      {task.status !== 'suggested' && (
        <input
          type="checkbox"
          className="task-check"
          aria-label={task.status === 'done' ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
          checked={task.status === 'done'}
          onChange={(e) => {
            const status = e.target.checked ? 'done' : 'open';
            void api.updateTask(task.id, { status }).then(
              () => toast.show(status === 'done' ? `Done: ${task.title}` : 'Moved back to To do', { label: 'Undo', run: () => set({ status: task.status }) }),
              toast.showError,
            );
          }}
        />
      )}
      <div className="grow task-body">
        <div className="task-title" dir="auto">
          {task.title}
        </div>
        {task.description && (
          <div className="muted small" dir="auto">
            {task.description}
          </div>
        )}
        <div className="task-meta small">
          {due && <span className={`due ${due.tone}`}>{due.text}</span>}
          {task.owner && <span>{task.owner}</span>}
          {task.priority && <span className={`prio ${task.priority}`}>{task.priority[0]!.toUpperCase() + task.priority.slice(1)} priority</span>}
          {task.remindAt && task.status === 'open' && (
            <span>
              <Bell size={12} aria-hidden /> {formatDateTime(task.remindAt)}
            </span>
          )}
          {task.recordingId && (
            <span className="task-source">
              {task.startMs !== null && (
                <button type="button" className="cite tabular" aria-label={`Play where this was said, at ${formatDuration(task.startMs)}`} onClick={playSource}>
                  {formatDuration(task.startMs)}
                </button>
              )}
              <button type="button" className="link-btn" dir="auto" onClick={() => go({ name: 'recording', id: task.recordingId! })}>
                {task.recordingTitle}
              </button>
            </span>
          )}
        </div>
        {task.status === 'suggested' && task.sourceText && (
          <blockquote className="task-quote small" dir="auto">
            “{task.sourceText}”
          </blockquote>
        )}
      </div>
      {task.status === 'suggested' ? (
        <div className="row">
          <Button size="sm" variant="primary" icon={Check} onClick={() => set({ status: 'open' })}>
            Approve
          </Button>
          <IconButton icon={Pencil} label="Edit, then approve" onClick={onEdit} />
          <IconButton icon={X} label="Dismiss" onClick={() => set({ status: 'dismissed' })} />
        </div>
      ) : (
        <Menu
          icon={Pencil}
          label={`Options for ${task.title}`}
          items={[
            { label: 'Edit', icon: Pencil, onSelect: onEdit },
            { label: 'Delete', icon: Trash2, danger: true, onSelect: onDelete },
          ]}
        />
      )}
    </li>
  );
}

/** Action items from recordings and your own (prompt §14): review, track, complete, and be reminded. */
export function TasksScreen() {
  const toast = useToast();
  const counts = useQuery(() => api.taskCounts(), [], ['tasks']);
  const [view, setView] = useState<View>('open');
  const [text, setText] = useState('');
  const list = useQuery(() => api.listTasks({ status: view as TaskStatus, text }), [view, text], ['tasks', 'library']);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);

  if (!counts.data) return <Loading />;
  const c = counts.data;

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        subtitle="Action items found in your recordings, after you approve them, and tasks you add yourself."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            New task
          </Button>
        }
      />
      <div className="row wrap">
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'suggested', label: `To review (${c.suggested})` },
            { value: 'open', label: `To do (${c.open})` },
            { value: 'done', label: 'Done' },
          ]}
        />
        <div className="grow" style={{ minWidth: 220 }}>
          <SearchField value={text} onChange={setText} placeholder="Search tasks" />
        </div>
      </div>
      {c.overdue > 0 && view === 'open' && (
        <p className="notice warning" role="status">
          {c.overdue === 1 ? '1 task is overdue.' : `${c.overdue} tasks are overdue.`}
        </p>
      )}
      {view === 'suggested' && !!list.data?.length && (
        <div className="row">
          <p className="muted small grow">EchoMind found these in your recordings. Approve the ones that are real tasks; dismissed ones will not be suggested again.</p>
          <Button
            size="sm"
            icon={CheckCheck}
            onClick={() => void Promise.all(list.data!.map((t) => api.updateTask(t.id, { status: 'open' }))).then(() => toast.show('All approved'), toast.showError)}
          >
            Approve all
          </Button>
        </div>
      )}

      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState
          icon={ListChecks}
          title={text ? 'No tasks match' : view === 'suggested' ? 'Nothing to review' : view === 'open' ? 'Nothing to do' : 'Nothing done yet'}
          message={
            text
              ? 'Try other words.'
              : view === 'suggested'
                ? 'Open a recording and choose Find action items, or use Action Items in AI Studio. What EchoMind finds waits here for you.'
                : view === 'open'
                  ? 'Approved action items and tasks you add appear here, soonest due first.'
                  : 'Completed tasks are kept here as your history.'
          }
        />
      ) : (
        <ul className="task-list">
          {list.data.map((t) => (
            <TaskRow key={t.id} task={t} onEdit={() => setEditing(t)} onDelete={() => setDeleting(t)} />
          ))}
        </ul>
      )}

      {editing && <EditDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog title="Delete this task?" message={`“${deleting.title}” is permanently removed.`} confirmLabel="Delete" destructive onConfirm={() => void api.deleteTask(deleting.id).catch(toast.showError)} onClose={() => setDeleting(null)} />}
    </div>
  );
}
