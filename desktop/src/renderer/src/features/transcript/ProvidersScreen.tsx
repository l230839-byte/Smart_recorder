import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { formatDateTime, formatDurationLong } from '@shared/format';
import { PROVIDER_INFO, TRANSCRIPT_LANGUAGES, TRANSCRIPTION_PROVIDERS, type TranscriptionProviderId } from '@shared/providers';
import { Button, Card, Loading, PageHeader } from '../../design/components';
import { api, errorMessage, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import './transcript.css';

export function KeyForm({ provider, onSaved }: { provider: TranscriptionProviderId; onSaved?: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const save = () => {
    api.saveProviderKey(provider, key).then(() => {
      setKey('');
      toast.show('Key saved, encrypted on this computer.');
      onSaved?.();
    }, toast.showError);
  };
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) save();
      }}
    >
      <input className="input grow" type="password" autoComplete="off" spellCheck={false} aria-label="API key" placeholder="Paste your API key" value={key} onChange={(e) => setKey(e.target.value)} />
      <Button type="submit" variant="primary" icon={KeyRound} disabled={!key.trim()}>
        Save key
      </Button>
    </form>
  );
}

export function ProvidersScreen() {
  const toast = useToast();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const provider = settings.data?.transcriptionProvider ?? 'groq';
  const status = useQuery(() => api.getProviderStatus(provider), [provider], ['settings']);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' } | { state: 'error'; message: string }>({ state: 'idle' });

  useEffect(() => setTest({ state: 'idle' }), [provider]);
  if (!settings.data) return <Loading />;
  const s = settings.data;
  const info = PROVIDER_INFO[provider];
  const update = (patch: Parameters<typeof api.updateSettings>[0]) => void api.updateSettings(patch).catch(toast.showError);

  const runTest = () => {
    setTest({ state: 'busy' });
    api.testProvider(provider).then(
      () => setTest({ state: 'ok' }),
      (e: unknown) => setTest({ state: 'error', message: errorMessage(e) }),
    );
  };

  return (
    <div className="page settings">
      <PageHeader title="AI providers" subtitle="Use free services with your own key. Keys are encrypted, and are only ever sent to the service they belong to." />

      <section className="stack">
        <h2>Transcription</h2>
        <div className="stack" role="radiogroup" aria-label="Transcription provider" style={{ gap: 'var(--s2)' }}>
          {TRANSCRIPTION_PROVIDERS.map((id) => (
            <button key={id} type="button" className="provider-choice" role="radio" aria-checked={provider === id} onClick={() => update({ transcriptionProvider: id, transcriptionModel: null })}>
              <span>
                <h3>{PROVIDER_INFO[id].label}</h3>
                <span className="muted small">{PROVIDER_INFO[id].hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {!info.local && (
        <Card>
          {s.offlineOnly && (
            <div className="notice warning" role="status" style={{ marginBottom: 'var(--s3)' }}>
              Offline only is on, so EchoMind will not contact this service. You can change that in Settings.
            </div>
          )}
          {provider === 'custom' && (
            <div className="field" style={{ marginBottom: 'var(--s3)' }}>
              <label htmlFor="base-url">Service address</label>
              <input
                id="base-url"
                className="input"
                spellCheck={false}
                placeholder="https://example.com/v1"
                value={baseUrl ?? s.customBaseUrl ?? ''}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => {
                  if (baseUrl !== null && baseUrl.trim() !== (s.customBaseUrl ?? '')) update({ customBaseUrl: baseUrl.trim() || null });
                }}
              />
              <span className="muted small">Must be https://, unless it runs on this computer.</span>
            </div>
          )}

          <div className="field">
            <span className="field-label">API key{info.needsKey ? '' : ' (if the service needs one)'}</span>
            {status.data?.hasKey ? (
              <div className="row">
                <CircleCheck size={18} aria-hidden style={{ color: 'var(--success)' }} />
                <span className="grow">A key is saved and encrypted.</span>
                <Button icon={Trash2} onClick={() => void api.clearProviderKey(provider).catch(toast.showError)}>
                  Remove key
                </Button>
              </div>
            ) : status.data && !status.data.secureStorage ? (
              <div className="notice error" role="alert">
                Windows secure storage is not available, so keys cannot be saved safely.
              </div>
            ) : (
              <KeyForm provider={provider} />
            )}
          </div>

          {info.keyUrl && (
            <p className="small" style={{ marginTop: 'var(--s2)' }}>
              <button type="button" className="link" onClick={() => void api.openExternal(info.keyUrl!)}>
                Get a free key <ExternalLink size={12} aria-hidden />
              </button>
            </p>
          )}

          <div className="row wrap" style={{ marginTop: 'var(--s4)' }}>
            <Button onClick={runTest} disabled={test.state === 'busy' || s.offlineOnly}>
              {test.state === 'busy' ? 'Testing…' : 'Test connection'}
            </Button>
            {test.state === 'ok' && (
              <span className="row small" role="status" style={{ color: 'var(--success)' }}>
                <CircleCheck size={15} aria-hidden /> Connected. No audio was sent.
              </span>
            )}
            {test.state === 'error' && (
              <span className="small" role="alert" style={{ color: 'var(--danger)' }}>
                {test.message}
              </span>
            )}
          </div>

          <div className="setting-line" style={{ marginTop: 'var(--s3)' }}>
            <div className="grow">
              Permission to send audio
              <div className="muted small">{status.data?.consented ? 'You agreed. You can withdraw this at any time.' : 'You will be asked before the first upload.'}</div>
            </div>
            {status.data?.consented && <Button onClick={() => void api.revokeConsent(provider).catch(toast.showError)}>Withdraw</Button>}
          </div>
        </Card>
      )}

      <Card>
        {info.models.length > 1 && (
          <div className="setting-line">
            <label className="grow" htmlFor="model">
              Model
            </label>
            <select id="model" className="select setting-select" value={s.transcriptionModel ?? info.models[0]} onChange={(e) => update({ transcriptionModel: e.target.value })}>
              {info.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
        )}
        {provider === 'custom' && (
          <div className="setting-line">
            <label className="grow" htmlFor="custom-model">
              Model name
            </label>
            <input id="custom-model" className="input setting-input" spellCheck={false} defaultValue={s.transcriptionModel ?? info.models[0]} onBlur={(e) => update({ transcriptionModel: e.target.value.trim() || null })} />
          </div>
        )}
        <div className="setting-line">
          <label className="grow" htmlFor="default-language">
            Default language
            <div className="muted small">For mixed English and Urdu, try Detect automatically first. Results vary by provider.</div>
          </label>
          <select id="default-language" className="select setting-select" value={s.transcriptionLanguage} onChange={(e) => update({ transcriptionLanguage: e.target.value })}>
            {TRANSCRIPT_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </Card>
    </div>
  );
}

/** Replaces the subscription screen: shows real usage, and never claims "unlimited" (prompt §23). */
export function UsageScreen() {
  const toast = useToast();
  const usage = useQuery(() => api.getUsage(), [], ['jobs']);
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const limit = settings.data?.dailyAudioLimitMinutes;
  if (!usage.data || !settings.data) return <Loading />;

  return (
    <div className="page settings">
      <PageHeader title="Usage and limits" subtitle="EchoMind has no payments or paid plans. Free services set their own limits, which change, so check the provider's page for current values." />
      <Card>
        <div className="setting-line">
          <label className="grow" htmlFor="daily-limit">
            Warn me above this much audio per day
            <div className="muted small">Your own reminder, in minutes. Leave empty for no warning.</div>
          </label>
          <input
            id="daily-limit"
            className="input setting-input"
            type="number"
            min={1}
            defaultValue={limit ?? ''}
            onBlur={(e) => {
              const value = Number(e.target.value);
              void api.updateSettings({ dailyAudioLimitMinutes: e.target.value && value > 0 ? Math.round(value) : null }).catch(toast.showError);
            }}
          />
        </div>
      </Card>
      {usage.data.length === 0 ? (
        <p className="muted">No AI usage yet.</p>
      ) : (
        usage.data.map((u) => {
          const info = PROVIDER_INFO[u.provider as TranscriptionProviderId];
          const over = limit && u.audioMsToday > limit * 60_000;
          return (
            <Card key={u.provider}>
              <div className="row">
                <h2 className="grow">{info?.label ?? u.provider}</h2>
                {info?.limitsUrl && (
                  <button type="button" className="link small" onClick={() => void api.openExternal(info.limitsUrl!)}>
                    See current limits <ExternalLink size={12} aria-hidden />
                  </button>
                )}
              </div>
              {over && (
                <div className="notice warning" role="status" style={{ marginTop: 'var(--s2)' }}>
                  You passed your daily reminder of {limit} minutes.
                </div>
              )}
              <div className="usage-grid small">
                <span className="muted">Today</span>
                <span>
                  {u.requestsToday} requests, {formatDurationLong(u.audioMsToday)} of audio
                </span>
                <span className="muted">This month</span>
                <span>
                  {u.requestsMonth} requests, {formatDurationLong(u.audioMsMonth)} of audio
                </span>
                {u.rate?.remainingRequests !== null && u.rate?.remainingRequests !== undefined && (
                  <>
                    <span className="muted">Reported by the service</span>
                    <span>
                      {u.rate.remainingRequests}
                      {u.rate.limitRequests !== null ? ` of ${u.rate.limitRequests}` : ''} requests left{u.rateUpdatedAt ? ` at ${formatDateTime(u.rateUpdatedAt)}` : ''}
                    </span>
                  </>
                )}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
