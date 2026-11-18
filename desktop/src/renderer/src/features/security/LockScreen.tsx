import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import type { AppLockState } from '@shared/models';
import { Button } from '../../design/components';
import { api, errorMessage } from '../../lib/api';
import { recorder } from '../../lib/recorder';
import { BrandMark } from '../../shell/Shell';
import './security.css';

/**
 * Shown over everything while the app is locked. The main process refuses all data requests until the
 * right PIN is entered, so nothing behind this screen can load, play or be read.
 */
export function LockScreen({ state, onUnlocked }: { state: AppLockState; onUnlocked: (next: AppLockState) => void }) {
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const waiting = state.waitUntil !== null && state.waitUntil > now;

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [waiting]);

  const submit = () => {
    if (busy || !pin) return;
    setBusy(true);
    void api
      .unlockApp(pin)
      .then(
        (next) => {
          if (!next.locked) onUnlocked(next);
          else {
            setMessage(next.waitUntil ? `That PIN is not right. Wait ${Math.ceil((next.waitUntil - Date.now()) / 1000)} seconds before trying again.` : 'That PIN is not right.');
            onUnlocked(next);
          }
        },
        (e: unknown) => setMessage(errorMessage(e)),
      )
      .finally(() => {
        setBusy(false);
        setPin('');
        input.current?.focus();
      });
  };

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <form
        className="lock-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <BrandMark size={40} />
        <h1 id="lock-title">
          <Lock size={18} aria-hidden /> EchoMind is locked
        </h1>
        {recorder.isActive && <p className="lock-recording" role="status">Recording continues while locked.</p>}
        <label htmlFor="lock-pin" className="muted">
          Enter your PIN
        </label>
        <input
          ref={input}
          id="lock-pin"
          className="input lock-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          value={pin}
          disabled={waiting}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        {waiting ? (
          <p className="lock-message" role="alert">
            Too many wrong PINs. Try again in {Math.ceil((state.waitUntil! - now) / 1000)} seconds.
          </p>
        ) : (
          message && (
            <p className="lock-message" role="alert">
              {message}
            </p>
          )
        )}
        <Button type="submit" variant="primary" disabled={busy || waiting || pin.length < 4}>
          Unlock
        </Button>
        <p className="muted small">A forgotten PIN cannot be recovered. Your recordings stay in the data folder on this computer.</p>
      </form>
    </div>
  );
}
