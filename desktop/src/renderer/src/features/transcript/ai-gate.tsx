import { useCallback, useState, type ReactNode } from 'react';
import { PROVIDER_INFO, type TranscriptionProviderId } from '@shared/providers';
import { Button, ConfirmDialog, Dialog } from '../../design/components';
import { api } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';

type Blocked = { reason: 'offline-only' | 'needs-setup' | 'needs-consent'; provider: TranscriptionProviderId; retry: () => void };

/**
 * Starts transcription and handles what can stand in the way: offline-only, a missing key, or consent that
 * has not been given. The agreement screen appears before anything is sent to each provider (prompt §0).
 */
export function useTranscribe(): { start: (recordingIds: string[], language?: string) => void; dialogs: ReactNode } {
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

  const close = () => setBlocked(null);
  let dialogs: ReactNode = null;
  if (blocked?.reason === 'offline-only') {
    dialogs = (
      <ConfirmDialog
        title="Offline only is on"
        message={`Nothing can leave this computer while Offline only is on, and ${PROVIDER_INFO[blocked.provider].label} is a cloud service. Turn it off to continue, or pick the demo provider in Settings. You will still be asked to agree before anything is sent.`}
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
        title={`Set up ${PROVIDER_INFO[blocked.provider].label}`}
        message="Transcription needs a provider. Add your own free key in Settings, or try the demo provider first."
        confirmLabel="Open AI provider settings"
        onConfirm={() => go({ name: 'providers' })}
        onClose={close}
      />
    );
  } else if (blocked?.reason === 'needs-consent') {
    const info = PROVIDER_INFO[blocked.provider];
    dialogs = (
      <Dialog title={`Send audio to ${info.label}?`} onClose={close}>
        <p>{info.disclosure}</p>
        <p className="muted small">You only need to agree once per provider, and you can withdraw this in Settings. Recordings are never sent unless you start transcription.</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void api.acceptConsent(blocked.provider).then(blocked.retry, toast.showError);
            }}
          >
            I agree, transcribe
          </Button>
        </div>
      </Dialog>
    );
  }
  return { start, dialogs };
}
