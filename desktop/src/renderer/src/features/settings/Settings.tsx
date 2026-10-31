import { useEffect, useState } from 'react';
import { ChevronRight, FolderOpen, HardDrive } from 'lucide-react';
import type { Settings as SettingsModel, ThemeSetting } from '@shared/models';
import { Button, Card, ConfirmDialog, Loading, PageHeader, Segmented, SwitchRow } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import './settings.css';

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function Settings() {
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const info = useQuery(() => api.getAppInfo(), []);
  const toast = useToast();
  const { go } = useRouter();
  const [name, setName] = useState<string | null>(null);
  const [confirmOnline, setConfirmOnline] = useState(false);

  useEffect(() => {
    if (settings.data && name === null) setName(settings.data.displayName);
  }, [settings.data, name]);

  if (!settings.data) return <Loading />;
  const s = settings.data;
  const update = (patch: Partial<SettingsModel>) => void api.updateSettings(patch).catch(toast.showError);

  return (
    <div className="page settings">
      <PageHeader title="Settings" />

      <section className="stack" aria-labelledby="s-appearance">
        <h2 id="s-appearance">Appearance</h2>
        <Card>
          <div className="setting-line">
            <div className="grow">Theme</div>
            <Segmented label="Theme" options={THEMES} value={s.theme} onChange={(theme) => update({ theme })} />
          </div>
        </Card>
      </section>

      <section className="stack" aria-labelledby="s-profile">
        <h2 id="s-profile">Local profile</h2>
        <Card>
          <div className="setting-line">
            <label className="grow" htmlFor="display-name">
              Your name
              <div className="muted small">Stays on this computer.</div>
            </label>
            <input
              id="display-name"
              className="input setting-input"
              maxLength={60}
              value={name ?? ''}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if ((name ?? '').trim() !== s.displayName) update({ displayName: (name ?? '').trim() });
              }}
            />
          </div>
        </Card>
      </section>

      <section className="stack" aria-labelledby="s-privacy">
        <h2 id="s-privacy">Privacy</h2>
        <Card>
          <SwitchRow
            title="Offline only"
            subtitle={
              s.offlineOnly
                ? 'On. Nothing leaves this computer, and AI features that need a cloud provider stay off.'
                : 'Off. AI features may use providers you set up, and only after you agree to what is sent.'
            }
            checked={s.offlineOnly}
            onChange={(offlineOnly) => (offlineOnly ? update({ offlineOnly }) : setConfirmOnline(true))}
          />
        </Card>
      </section>

      <section className="stack" aria-labelledby="s-recording">
        <h2 id="s-recording">Recording</h2>
        <Card>
          <SwitchRow title="Noise suppression" subtitle="Reduces steady background noise while recording. Applied by your system's audio engine." checked={s.noiseSuppression} onChange={(noiseSuppression) => update({ noiseSuppression })} />
          <SwitchRow title="Automatic gain" subtitle="Keeps your voice at an even level." checked={s.autoGain} onChange={(autoGain) => update({ autoGain })} />
          <SwitchRow title="Echo cancellation" subtitle="Useful with speakers. Leave off when using headphones or recording a room." checked={s.echoCancellation} onChange={(echoCancellation) => update({ echoCancellation })} />
        </Card>
      </section>

      <section className="stack" aria-labelledby="s-storage">
        <h2 id="s-storage">Storage</h2>
        <Card>
          <button type="button" className="setting-link" onClick={() => go({ name: 'storage' })}>
            <HardDrive size={18} aria-hidden />
            <span className="grow">Storage and trash</span>
            <ChevronRight size={18} aria-hidden />
          </button>
        </Card>
      </section>

      <section className="stack" aria-labelledby="s-about">
        <h2 id="s-about">About</h2>
        <Card>
          <div className="setting-line">
            <div className="grow">
              EchoMind {info.data?.version}
              <div className="muted small selectable">
                Electron {info.data?.electron} · Chromium {info.data?.chromium} · SQLite {info.data?.sqlite}
              </div>
            </div>
          </div>
          <div className="setting-line">
            <div className="grow truncate">
              Data folder
              <div className="muted small selectable truncate" title={info.data?.dataDirectory}>
                {info.data?.dataDirectory}
              </div>
            </div>
            <Button icon={FolderOpen} onClick={() => void api.openDataFolder()}>
              Open
            </Button>
          </div>
        </Card>
      </section>

      {confirmOnline && (
        <ConfirmDialog
          title="Allow cloud AI features?"
          message="Nothing is sent right away. AI features can then use providers you set up with your own key, and EchoMind asks for your agreement before the first upload to each one."
          confirmLabel="Allow"
          onConfirm={() => update({ offlineOnly: false })}
          onClose={() => setConfirmOnline(false)}
        />
      )}
    </div>
  );
}
