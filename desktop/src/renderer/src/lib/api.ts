import { useCallback, useEffect, useRef, useState } from 'react';
import type { EchoApi, EchoBridge, EchoEvents } from '@shared/api';

declare global {
  interface Window {
    echomind: EchoBridge;
  }
}

/** Typed client for the main process: `api.getSettings()` becomes an IPC call. */
export const api = new Proxy({} as { [M in keyof EchoApi]: (...args: Parameters<EchoApi[M]>) => Promise<Awaited<ReturnType<EchoApi[M]>>> }, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) =>
      (window.echomind.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
});

export function onEvent<E extends keyof EchoEvents>(event: E, listener: (payload: EchoEvents[E]) => void): () => void {
  return window.echomind.on(event, listener);
}

/** Electron prefixes IPC errors with its own text; users should only see the message itself. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

export interface QueryResult<T> {
  data: T | undefined;
  error: string | null;
  reload: () => void;
}

/**
 * Loads data over IPC and reloads it when the named data areas change, so every screen
 * stays current without shared client-side state. Stale responses are ignored.
 */
export function useQuery<T>(load: () => Promise<T>, deps: unknown[], areas: EchoEvents['data:changed'][] = []): QueryResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    const id = ++request.current;
    loadRef.current().then(
      (value) => {
        if (id !== request.current) return;
        setData(value);
        setError(null);
      },
      (e: unknown) => {
        if (id === request.current) setError(errorMessage(e));
      },
    );
  }, []);

  useEffect(reload, deps);

  const areaKey = areas.join();
  useEffect(() => {
    if (!areaKey) return;
    return onEvent('data:changed', (area) => {
      if (areaKey.split(',').includes(area)) reload();
    });
  }, [areaKey, reload]);

  return { data, error, reload };
}
