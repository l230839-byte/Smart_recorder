import { useEffect, useState } from 'react';
import { CircleCheck, MicOff } from 'lucide-react';
import { SILENCE_AMPLITUDE } from '@shared/audio-level';
import type { Settings } from '@shared/models';
import { Button } from '../../design/components';
import { deviceName, micErrorMessage, openMicrophone } from '../../lib/recorder';

/** How long the check listens before saying it hears nothing. */
const QUIET_AFTER_MS = 3000;

interface Check {
  label: string;
  level: number;
  heard: boolean;
  quiet: boolean;
  fallback: boolean;
  error: string | null;
}

/**
 * A live microphone meter before recording starts, so a muted or wrong microphone is caught before a
 * lecture, not after it. Nothing is recorded or stored: the level is read and the stream is closed when
 * the screen closes or the choice changes.
 */
export function MicCheck({ settings, onUseDefault }: { settings: Settings; onUseDefault: () => void }) {
  const [check, setCheck] = useState<Check | null>(null);
  const { inputDeviceId, noiseSuppression, echoCancellation, autoGain } = settings;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    setCheck(null);
    void openMicrophone(settings).then(
      (opened) => {
        if (closed) {
          opened.stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = opened.stream;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const started = performance.now();
        let heard = false;
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v));
          if (peak > SILENCE_AMPLITUDE) heard = true;
          setCheck({
            label: deviceName(stream),
            level: Math.min(1, Math.sqrt(peak)),
            heard,
            quiet: !heard && performance.now() - started > QUIET_AFTER_MS,
            fallback: opened.fallback,
            error: null,
          });
        }, 80);
      },
      (e: unknown) => !closed && setCheck({ label: 'the microphone', level: 0, heard: false, quiet: false, fallback: false, error: micErrorMessage(e) }),
    );
    return () => {
      closed = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
    };
    // The stream depends only on these choices, not on the rest of the settings object.
  }, [inputDeviceId, noiseSuppression, echoCancellation, autoGain]);

  if (!check) return <div className="mic-check muted small">Checking the microphone…</div>;
  if (check.error) {
    return (
      <div className="notice error mic-check" role="alert">
        <MicOff size={18} aria-hidden />
        <span className="grow">{check.error}</span>
      </div>
    );
  }
  const percent = Math.round(check.level * 100);
  return (
    <div className={`mic-check ${check.quiet ? 'quiet' : ''}`}>
      <div className="row">
        <span className="small grow">
          Microphone check: <strong>{check.label}</strong>
          {check.fallback && ' (the selected microphone is not connected, so the default is used)'}
        </span>
        {check.heard ? (
          <span className="row small mic-ok">
            <CircleCheck size={15} aria-hidden /> Sound is coming through
          </span>
        ) : (
          <span className="muted small">Say something to test it</span>
        )}
      </div>
      <div className="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div style={{ width: `${percent}%` }} />
      </div>
      {check.quiet && (
        <div className="notice warning" role="alert">
          <MicOff size={18} aria-hidden />
          <span className="grow">
            <strong>No sound from {check.label}.</strong> It may be muted, switched off, or not the microphone you mean. A recording now would be silent.
          </span>
          {inputDeviceId && (
            <Button size="sm" onClick={onUseDefault}>
              Use system default
            </Button>
          )}
        </div>
      )}
      <span className="muted small">Nothing is recorded until you press Start recording.</span>
    </div>
  );
}
