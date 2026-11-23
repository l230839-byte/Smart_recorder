import { useEffect, useRef } from 'react';
import type { Settings } from '@shared/models';

const MORE_CONTRAST = '(prefers-contrast: more)';

/**
 * Puts the accent and contrast choices on <html>, where tokens.css reads them. Light or dark needs no
 * work here: the main process sets Electron's theme, which drives prefers-color-scheme. "system" contrast
 * follows Windows, and changes with it while EchoMind is open.
 */
export function useAppearance(settings: Pick<Settings, 'theme' | 'accent' | 'contrast'> | null | undefined): void {
  const first = useRef(true);
  const theme = settings?.theme;
  const accent = settings?.accent;
  const contrast = settings?.contrast;

  useEffect(() => {
    if (!accent || !contrast) return;
    const root = document.documentElement;
    const media = matchMedia(MORE_CONTRAST);
    const apply = () => {
      root.dataset.accent = accent;
      root.dataset.contrast = contrast === 'high' || (contrast === 'system' && media.matches) ? 'high' : 'standard';
    };
    // A short cross-fade for a change the person made; never on the first paint.
    if (!first.current) {
      root.classList.add('theme-changing');
      window.setTimeout(() => root.classList.remove('theme-changing'), 260);
    }
    first.current = false;
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, accent, contrast]);
}
