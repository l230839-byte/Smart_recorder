import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from './api';

interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

interface ToastValue {
  /** Shows a message; the id lets a message that stops being true be taken back early. */
  show: (text: string, action?: Toast['action']) => number;
  showError: (e: unknown) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (text: string, error: boolean, action?: Toast['action']) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-2), { id, text, error, action }]);
      setTimeout(() => dismiss(id), error || action ? 7000 : 3500);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastValue>(
    () => ({
      show: (text, action) => push(text, false, action),
      showError: (e) => void push(errorMessage(e), true),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ color: 'inherit' }}
                onClick={() => {
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                  t.action?.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
