import { useCallback, useState, type ReactNode } from 'react';
import type { AiPurpose } from '@shared/models';
import { LLM_PROVIDER_INFO, PROVIDER_INFO, type LlmProviderId, type TranscriptionProviderId } from '@shared/providers';
import type { SummaryOptions } from '@shared/summaries';
import { Button, ConfirmDialog, Dialog } from '../../design/components';
import { api } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';

type Blocked = {
  reason: 'offline-only' | 'needs-setup' | 'needs-consent';
  provider: TranscriptionProviderId | LlmProviderId;
  purpose: AiPurpose;
  retry: () => void;
};

function infoFor(blocked: Blocked) {
  return blocked.purpose === 'text' ? LLM_PROVIDER_INFO[blocked.provider as LlmProviderId] : PROVIDER_INFO[blocked.provider as TranscriptionProviderId];
}

/**
 * Starts AI work and handles what can stand in the way: offline-only, a missing key, or consent that has
 * not been given. The agreement screen appears before anything is sent to each provider (prompt §0).
 */
export function useTranscribe() {
  const { go } = useRouter();
  const toast = useToast();
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const start = useCallback(
    (recordingIds: string[], language?: string) => {
      const run = async () => {
        for (const id of recordingIds) {
          const outcome = await api.requestTranscription(id, language);
          if (!outcome.ok) {
            setBlocked({ ...outcome, retry: () => void run() });
            return;
          }
        }
        if (recordingIds.length > 1) toast.show(`Added ${recordingIds.length} recordings to the transcription queue`);
      };
      run().catch(toast.showError);
    },
    [toast],
  );

  /** Runs text AI work. `request` is asked again after each obstacle is cleared. */
  const startText = useCallback(
    (request: () => ReturnType<typeof api.requestSummary>) => {
      const run = async () => {
        const outcome = await request();
        if (outcome.ok) return;
        if (outcome.reason === 'needs-transcript') {
          toast.showError(new Error('Create a transcript first.'));
          return;
        }
        setBlocked({ ...outcome, retry: () => void run() });
      };
      run().catch(toast.showError);
    },
    [toast],
  );

  const startSummary = useCallback((id: string, options: SummaryOptions) => startText(() => api.requestSummary(id, options)), [startText]);
  const startChapters = useCallback((id: string) => startText(() => api.requestChapters(id)), [startText]);
  const startSuggestions = useCallback((id: string) => startText(() => api.requestSuggestions(id)), [startText]);

  const close = () => setBlocked(null);
  let dialogs: ReactNode = null;
  if (blocked?.reason === 'offline-only') {
    dialogs = (
      <ConfirmDialog
        title="Offline only is on"
        message={`Nothing can leave this computer while Offline only is on, and ${infoFor(blocked).label} is a cloud service. Turn it off to continue, or pick the demo provider in Settings. You will still be asked to agree before anything is sent.`}
        confirmLabel="Turn off Offline only"
        onConfirm={() => {
          void api.updateSettings({ offlineOnly: false }).then(blocked.retry, toast.showError);
        }}
        onClose={close}
      />
    );
  } else if (blocked?.reason === 'needs-setup') {
    dialogs = (
      <ConfirmDialog
        title={`Set up ${infoFor(blocked).label}`}
        message="This needs a provider. Add your own free key in Settings, or try the demo provider first."
        confirmLabel="Open AI provider settings"
        onConfirm={() => go({ name: 'providers' })}
        onClose={close}
      />
    );
  } else if (blocked?.reason === 'needs-consent') {
    const info = infoFor(blocked);
    const what = blocked.purpose === 'text' ? 'transcript text' : 'audio';
    dialogs = (
      <Dialog title={`Send ${what} to ${info.label}?`} onClose={close}>
        <p>{info.disclosure}</p>
        <p className="muted small">You only need to agree once for each provider and kind of data, and you can withdraw this in Settings. Nothing is sent unless you start it.</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void api.acceptConsent(blocked.provider, blocked.purpose).then(blocked.retry, toast.showError);
            }}
          >
            I agree, continue
          </Button>
        </div>
      </Dialog>
    );
  }
  return { start, startSummary, startChapters, startSuggestions, dialogs };
}
