import { useEffect, useId, useState } from 'react';
import { DatabaseBackup, History, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes, formatDateTime, plural } from '@shared/format';
import { Button, Card, ConfirmDialog, Dialog, PageHeader, ProgressBar } from '../../design/components';
import { api, errorMessage, onEvent, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';

type Busy = { what: 'backup' | 'restore'; done: number; total: number } | null;
type Picked = { createdAt: number; appVersion: string; recordings: number | null; encrypted: boolean; name: string };

function PasswordDialog({ mode, picked, onSubmit, onClose }: { mode: 'backup' | 'restore'; picked?: Picked; onSubmit: (password: string) => void; onClose: () => void }) {
  const id = useId();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [understood, setUnderstood] = useState(false);
  const valid = mode === 'restore' ? password.length > 0 : password.length >= 8 && password === again && understood;
  return (
    <Dialog title={mode === 'backup' ? 'Create a backup' : 'Restore this backup?'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(password);
        }}
      >
        {mode === 'restore' && picked && (
          <p className="muted">
            {picked.name}, made {formatDateTime(picked.createdAt)}
            {picked.recordings !== null ? `, with ${plural(picked.recordings, 'recording')}` : ''}. It replaces your current library when EchoMind restarts; the current one is kept aside until you remove it.
          </p>
        )}
        <div className="field">
          <label htmlFor={`${id}-p`}>{mode === 'backup' ? 'Password for this backup (at least 8 characters)' : 'Backup password'}</label>
          <input id={`${id}-p`} className="input" type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {mode === 'backup' && (
          <>
            <div className="field">
              <label htmlFor={`${id}-a`}>Type it again</label>
              <input id={`${id}-a`} className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
              {again && again !== password && <span className="small" style={{ color: 'var(--danger)' }}>The two passwords are different.</span>}
            </div>
            <label className="row small">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand that without this password the backup cannot be opened by anyone, including me.
            </label>
            <p className="muted small">Includes recordings, transcripts, summaries, documents, chats, Studio results, tasks and settings. API keys are not included; add them again after restoring on another computer.</p>
          </>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid}>
            {mode === 'backup' ? 'Choose where to save' : 'Check and restore'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Encrypted backups to a folder of the user's choice, including a synced cloud folder (prompt §15.9). */
export function BackupScreen() {
  const toast = useToast();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const previous = useQuery(() => api.previousData(), [], ['settings', 'library']);
  const [busy, setBusy] = useState<Busy>(null);
  const [dialog, setDialog] = useState<'backup' | 'restore' | 'restart' | 'delete-previous' | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [restoreInfo, setRestoreInfo] = useState<{ recordings: number; createdAt: number } | null>(null);

  useEffect(() => onEvent('archive:progress', ({ done, total }) => setBusy((b) => (b ? { ...b, done, total } : b))), []);

  const backup = (password: string) => {
    setDialog(null);
    setBusy({ what: 'backup', done: 0, total: 1 });
    void api
      .createBackup(password)
      .then((result) => result && toast.show(`Backup saved: ${plural(result.recordings, 'recording')}, ${formatBytes(result.sizeBytes)}`), toast.showError)
      .finally(() => setBusy(null));
  };

  const pick = () =>
    void api.pickBackup().then((p) => {
      if (!p) return;
      setPicked(p);
      setDialog('restore');
    }, toast.showError);

  const restore = (password: string) => {
    setDialog(null);
    setBusy({ what: 'restore', done: 0, total: 1 });
    void api
      .restoreBackup(password)
      .then(
        (info) => {
          setRestoreInfo(info);
          setDialog('restart');
        },
        (e: unknown) => {
          toast.showError(new Error(errorMessage(e)));
          if (/password/i.test(errorMessage(e))) setDialog('restore');
        },
      )
      .finally(() => setBusy(null));
  };

  return (
    <div className="page">
      <PageHeader title="Backup and restore" subtitle="An encrypted copy of your whole library, saved wherever you choose: another drive, a USB stick, or a folder your cloud drive syncs." />
      <Card>
        <div className="setting-line">
          <DatabaseBackup size={20} aria-hidden />
          <div className="grow">
            Create a backup
            <div className="muted small">{settings.data?.lastBackupAt ? `Last backup ${formatDateTime(settings.data.lastBackupAt)}` : 'No backup yet'}</div>
          </div>
          <Button variant="primary" disabled={!!busy} onClick={() => setDialog('backup')}>
            Back up now
          </Button>
        </div>
        <div className="setting-line">
          <RotateCcw size={20} aria-hidden />
          <div className="grow">
            Restore from a backup
            <div className="muted small">Replaces this library with the one in the backup.</div>
          </div>
          <Button disabled={!!busy} onClick={pick}>
            Choose a backup
          </Button>
        </div>
        {busy && (
          <div className="stack" role="status" style={{ gap: 6, padding: '8px 0' }}>
            <span className="small">
              {busy.what === 'backup' ? 'Encrypting and saving' : 'Checking and unpacking'}… {busy.total > 1 ? `${formatBytes(busy.done)} of ${formatBytes(busy.total)}` : ''}
            </span>
            <ProgressBar value={busy.total ? busy.done / busy.total : 0} label={busy.what === 'backup' ? 'Backup progress' : 'Restore progress'} />
          </div>
        )}
      </Card>

      {previous.data && (
        <Card>
          <div className="setting-line">
            <History size={20} aria-hidden />
            <div className="grow">
              Library from before the last restore
              <div className="muted small">Kept in case you need it ({formatBytes(previous.data.sizeBytes)}). Remove it once you have checked the restored library.</div>
            </div>
            <Button icon={Trash2} onClick={() => setDialog('delete-previous')}>
              Remove
            </Button>
          </div>
        </Card>
      )}

      <p className="muted small">Backups are encrypted with AES-256 using your password. Keep the password somewhere safe: it cannot be reset.</p>

      {(dialog === 'backup' || dialog === 'restore') && <PasswordDialog mode={dialog} picked={picked ?? undefined} onSubmit={dialog === 'backup' ? backup : restore} onClose={() => setDialog(null)} />}
      {dialog === 'restart' && restoreInfo && (
        <ConfirmDialog
          title="Ready to restore"
          message={`The backup is checked and contains ${plural(restoreInfo.recordings, 'recording')}. EchoMind restarts to put it in place.`}
          confirmLabel="Restart now"
          onConfirm={() => void api.restartToRestore()}
          onClose={() => {
            setDialog(null);
            void api.cancelRestore();
          }}
        />
      )}
      {dialog === 'delete-previous' && (
        <ConfirmDialog
          title="Remove the previous library?"
          message="The library from before the last restore is permanently deleted. Your current library is not affected."
          confirmLabel="Remove"
          destructive
          onConfirm={() => void api.deletePreviousData().then(previous.reload, toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
