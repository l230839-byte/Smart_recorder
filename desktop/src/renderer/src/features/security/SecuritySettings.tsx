import { useId, useState } from 'react';
import { ChevronRight, DatabaseBackup, Lock } from 'lucide-react';
import type { Settings } from '@shared/models';
import { Button, Card, Dialog, SwitchRow } from '../../design/components';
import { api, errorMessage, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';

const AUTO_LOCK: { value: number; label: string }[] = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'After 1 minute' },
  { value: 5, label: 'After 5 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 60, label: 'After 1 hour' },
];

type PinMode = 'set' | 'change' | 'remove';

function PinDialog({ mode, onClose }: { mode: PinMode; onClose: () => void }) {
  const toast = useToast();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 12);
  const needsNew = mode !== 'remove';
  const valid = (mode === 'set' || current.length >= 4) && (!needsNew || (pin.length >= 4 && pin === again));

  const save = () => {
    const run = mode === 'remove' ? api.disableAppLock(current) : api.setAppPin(pin, mode === 'change' ? current : null);
    void run.then(
      () => {
        toast.show(mode === 'set' ? 'App lock is on' : mode === 'change' ? 'PIN changed' : 'App lock is off');
        onClose();
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };

  return (
    <Dialog title={mode === 'set' ? 'Turn on app lock' : mode === 'change' ? 'Change PIN' : 'Turn off app lock'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save();
        }}
      >
        {mode !== 'set' && (
          <div className="field">
            <label htmlFor={`${id}-c`}>Current PIN</label>
            <input id={`${id}-c`} className="input" type="password" inputMode="numeric" autoFocus value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
          </div>
        )}
        {needsNew && (
          <>
            <div className="field">
              <label htmlFor={`${id}-n`}>{mode === 'set' ? 'PIN (4 to 12 digits)' : 'New PIN (4 to 12 digits)'}</label>
              <input id={`${id}-n`} className="input" type="password" inputMode="numeric" autoFocus={mode === 'set'} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-a`}>Type it again</label>
              <input id={`${id}-a`} className="input" type="password" inputMode="numeric" value={again} onChange={(e) => setAgain(digits(e.target.value))} />
              {again.length >= 4 && again !== pin && <span className="small" style={{ color: 'var(--danger)' }}>The two PINs are different.</span>}
            </div>
            <p className="muted small">A forgotten PIN cannot be recovered. App lock stops others from using EchoMind on this computer; it does not encrypt your files. For that, use Windows BitLocker.</p>
          </>
        )}
        {error && (
          <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={mode === 'remove' ? 'danger' : 'primary'} type="submit" disabled={!valid}>
            {mode === 'set' ? 'Turn on' : mode === 'change' ? 'Change PIN' : 'Turn off'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** App lock, starting with Windows, and backups: the "Account and privacy" settings of prompt §16. */
export function SecuritySettings({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const toast = useToast();
  const { go } = useRouter();
  const lock = useQuery(() => api.getAppLockState(), [], ['settings']);
  const [dialog, setDialog] = useState<PinMode | null>(null);
  const reload = lock.reload;

  return (
    <>
      <Card>
        <SwitchRow
          title="App lock"
          subtitle={lock.data?.enabled ? 'On. EchoMind asks for your PIN when it opens and after it locks.' : 'Ask for a PIN when EchoMind opens, after it has been idle, and when Windows locks.'}
          checked={!!lock.data?.enabled}
          onChange={(on) => setDialog(on ? 'set' : 'remove')}
        />
        {lock.data?.enabled && (
          <>
            <div className="setting-line">
              <label className="grow" htmlFor="auto-lock">
                Lock automatically
                <div className="muted small">When this computer has had no keyboard or mouse use for this long.</div>
              </label>
              <select
                id="auto-lock"
                className="select setting-input"
                value={lock.data.autoLockMinutes}
                onChange={(e) => void api.setAutoLock(Number(e.target.value)).then(reload, toast.showError)}
              >
                {AUTO_LOCK.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-line">
              <div className="grow" />
              <Button onClick={() => setDialog('change')}>Change PIN</Button>
              <Button icon={Lock} onClick={() => void api.lockApp().catch(toast.showError)}>
                Lock now
              </Button>
            </div>
          </>
        )}
        <SwitchRow
          title="Start with Windows"
          subtitle="Opens EchoMind minimized when you sign in to Windows, so task reminders appear on time. Works in the installed app."
          checked={settings.openAtLogin}
          onChange={(openAtLogin) => update({ openAtLogin })}
        />
        <button type="button" className="setting-link" onClick={() => go({ name: 'backup' })}>
          <DatabaseBackup size={18} aria-hidden />
          <span className="grow">
            Backup and restore
            <span className="muted small"> · {settings.lastBackupAt ? `last backup ${new Date(settings.lastBackupAt).toLocaleDateString()}` : 'no backup yet'}</span>
          </span>
          <ChevronRight size={18} aria-hidden />
        </button>
      </Card>
      {dialog && (
        <PinDialog
          mode={dialog}
          onClose={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </>
  );
}
