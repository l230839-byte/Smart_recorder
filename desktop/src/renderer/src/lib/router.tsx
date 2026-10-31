import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** A small typed route stack. The app has no URLs, so a browser router would add nothing. */
export type Route =
  | { name: 'home' }
  | { name: 'library'; collectionId?: string }
  | { name: 'record' }
  | { name: 'studio' }
  | { name: 'settings' }
  | { name: 'recording'; id: string; startMs?: number }
  | { name: 'player'; id: string }
  | { name: 'import'; batchId?: string }
  | { name: 'collections' }
  | { name: 'storage' }
  | { name: 'transcript'; id: string; startMs?: number }
  | { name: 'jobs' }
  | { name: 'providers' }
  | { name: 'usage' };

export type TopLevel = 'home' | 'library' | 'record' | 'studio' | 'settings';

const TOP_LEVEL_OF: Record<Route['name'], TopLevel> = {
  home: 'home',
  library: 'library',
  record: 'record',
  studio: 'studio',
  settings: 'settings',
  recording: 'library',
  player: 'library',
  import: 'library',
  collections: 'library',
  storage: 'settings',
  transcript: 'library',
  jobs: 'home',
  providers: 'settings',
  usage: 'settings',
};

interface RouterValue {
  route: Route;
  section: TopLevel;
  canGoBack: boolean;
  /** Opens a screen on top of the current one. */
  go: (route: Route) => void;
  /** Switches sidebar section: clears the stack, so Back never crosses sections. */
  switchTo: (route: Route) => void;
  back: () => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);

  const go = useCallback((route: Route) => setStack((s) => [...s, route]), []);
  const switchTo = useCallback((route: Route) => setStack([route]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  // Mouse back button and Alt+Left, as in other desktop apps.
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') back();
    };
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, [back]);

  const route = stack[stack.length - 1]!;
  const value = useMemo(
    () => ({ route, section: TOP_LEVEL_OF[route.name], canGoBack: stack.length > 1, go, switchTo, back }),
    [route, stack.length, go, switchTo, back],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside RouterProvider');
  return value;
}
