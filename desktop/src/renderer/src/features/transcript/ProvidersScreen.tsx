import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { formatDateTime, formatDurationLong } from '@shared/format';
import type { AiPurpose } from '@shared/models';
import { LLM_PROVIDER_INFO, LLM_PROVIDERS, PROVIDER_INFO, providerLabel, TRANSCRIPT_LANGUAGES, TRANSCRIPTION_PROVIDERS, type LlmProviderId, type TranscriptionProviderId } from '@shared/providers';
import { Button, Card, Loading, PageHeader } from '../../design/components';
import { api, errorMessage, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import './transcript.css';

type AnyProvider = TranscriptionProviderId | LlmProviderId;

export function KeyForm({ provider, onSaved }: { provider: AnyProvider; onSaved?: () => void }) {
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

/** One provider's connection: address, key, test and consent. The same for audio and text services. */
function ProviderCard({ provider, purpose, offlineOnly, baseUrl, onBaseUrl }: { provider: AnyProvider; purpose: AiPurpose; offlineOnly: boolean; baseUrl: string | null; onBaseUrl: (url: string | null) => void }) {
  const toast = useToast();
  const info = purpose === 'text' ? LLM_PROVIDER_INFO[provider as LlmProviderId] : PROVIDER_INFO[provider as TranscriptionProviderId];
  const status = useQuery(() => api.getProviderStatus(provider, purpose), [provider, purpose], ['settings']);
  const [url, setUrl] = useState<string | null>(null);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' } | { state: 'error'; message: string }>({ state: 'idle' });
  const custom = provider === 'custom' || provider === 'custom-chat';

  useEffect(() => {
    setTest({ state: 'idle' });
    setUrl(null);
  }, [provider]);

  if (info.local) return null;

  const runTest = () => {
    setTest({ state: 'busy' });
    api.testProvider(provider, purpose).then(
      () => setTest({ state: 'ok' }),
      (e: unknown) => setTest({ state: 'error', message: errorMessage(e) }),
    );
  };

  return (
    <Card>
      {offlineOnly && (
        <div className="notice warning" role="status" style={{ marginBottom: 'var(--s3)' }}>
          Offline only is on, so EchoMind will not contact this service. You can change that in Settings.
        </div>
      )}
      {custom && (
        <div className="field" style={{ marginBottom: 'var(--s3)' }}>
          <label htmlFor={`base-url-${purpose}`}>Service address</label>
          <input
            id={`base-url-${purpose}`}
            className="input"
            spellCheck={false}
            placeholder="https://example.com/v1"
            value={url ?? baseUrl ?? ''}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => {
              if (url !== null && url.trim() !== (baseUrl ?? '')) onBaseUrl(url.trim() || null);
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
        <Button onClick={runTest} disabled={test.state === 'busy' || offlineOnly}>
          {test.state === 'busy' ? 'Testing…' : 'Test connection'}
        </Button>
        {test.state === 'ok' && (
          <span className="row small" role="status" style={{ color: 'var(--success)' }}>
            <CircleCheck size={15} aria-hidden /> Connected. Nothing from your recordings was sent.
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
          Permission to send {purpose === 'text' ? 'transcript text' : 'audio'}
          <div className="muted small">{status.data?.consented ? 'You agreed. You can withdraw this at any time.' : 'You will be asked before the first time.'}</div>
        </div>
        {status.data?.consented && <Button onClick={() => void api.revokeConsent(provider, purpose).catch(toast.showError)}>Withdraw</Button>}
      </div>
    </Card>
  );
}

function ModelField({ id, models, value, custom, onChange }: { id: string; models: string[]; value: string | null; custom: boolean; onChange: (model: string | null) => void }) {
  if (custom) {
    return (
      <div className="setting-line">
        <label className="grow" htmlFor={id}>
          Model name
        </label>
        <input key={value ?? 'default'} id={id} className="input setting-input" spellCheck={false} defaultValue={value ?? models[0]} onBlur={(e) => onChange(e.target.value.trim() || null)} />
      </div>
    );
  }
  if (models.length < 2) return null;
  return (
    <div className="setting-line">
      <label className="grow" htmlFor={id}>
        Model
      </label>
      <select id={id} className="select setting-select" value={value ?? models[0]} onChange={(e) => onChange(e.target.value)}>
        {models.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
    </div>
  );
}

export function ProvidersScreen() {
  const toast = useToast();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  if (!settings.data) return <Loading />;
  const s = settings.data;
  const provider = s.transcriptionProvider;
  const llm = s.llmProvider;
  const info = PROVIDER_INFO[provider];
  const llmInfo = LLM_PROVIDER_INFO[llm];
  const update = (patch: Parameters<typeof api.updateSettings>[0]) => void api.updateSettings(patch).catch(toast.showError);

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
        <ProviderCard provider={provider} purpose="audio" offlineOnly={s.offlineOnly} baseUrl={s.customBaseUrl} onBaseUrl={(customBaseUrl) => update({ customBaseUrl })} />
        <Card>
          <ModelField id="model" models={info.models} value={s.transcriptionModel} custom={provider === 'custom'} onChange={(transcriptionModel) => update({ transcriptionModel })} />
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
      </section>

      <section className="stack">
        <h2>Summaries and writing</h2>
        <div className="stack" role="radiogroup" aria-label="Writing provider" style={{ gap: 'var(--s2)' }}>
          {LLM_PROVIDERS.map((id) => (
            <button key={id} type="button" className="provider-choice" role="radio" aria-checked={llm === id} onClick={() => update({ llmProvider: id, llmModel: null })}>
              <span>
                <h3>{LLM_PROVIDER_INFO[id].label}</h3>
                <span className="muted small">{LLM_PROVIDER_INFO[id].hint}</span>
              </span>
            </button>
          ))}
        </div>
        <ProviderCard provider={llm} purpose="text" offlineOnly={s.offlineOnly} baseUrl={s.llmBaseUrl} onBaseUrl={(llmBaseUrl) => update({ llmBaseUrl })} />
        {!llmInfo.local && (
          <Card>
            <ModelField id="llm-model" models={llmInfo.models} value={s.llmModel} custom={llm === 'custom-chat'} onChange={(llmModel) => update({ llmModel })} />
          </Card>
        )}
      </section>
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
            Remind me above this much audio per day
            <div className="muted small">Your own reminder, in minutes. Leave empty for none.</div>
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
          const limitsUrl = (PROVIDER_INFO as Record<string, { limitsUrl: string | null }>)[u.provider]?.limitsUrl ?? (LLM_PROVIDER_INFO as Record<string, { limitsUrl: string | null }>)[u.provider]?.limitsUrl;
          const over = limit && u.audioMsToday > limit * 60_000;
          const describe = (requests: number, audioMs: number, tokens: number) => [`${requests} requests`, audioMs > 0 ? `${formatDurationLong(audioMs)} of audio` : null, tokens > 0 ? `${tokens.toLocaleString()} tokens` : null].filter(Boolean).join(', ');
          return (
            <Card key={u.provider}>
              <div className="row">
                <h2 className="grow">{providerLabel(u.provider)}</h2>
                {limitsUrl && (
                  <button type="button" className="link small" onClick={() => void api.openExternal(limitsUrl)}>
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
                <span>{describe(u.requestsToday, u.audioMsToday, u.tokensToday)}</span>
                <span className="muted">This month</span>
                <span>{describe(u.requestsMonth, u.audioMsMonth, u.tokensMonth)}</span>
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
