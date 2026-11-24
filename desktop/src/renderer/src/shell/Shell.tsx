import { useEffect, type ReactNode } from 'react';
import { ArrowLeft, Home, Library, Mic, Search, Settings, Sparkles } from 'lucide-react';
import { IconButton, type IconType } from '../design/components';
import { useRouter, type Route, type TopLevel } from '../lib/router';
import './shell.css';

const SECTIONS: { key: TopLevel; label: string; icon: IconType; route: Route }[] = [
  { key: 'home', label: 'Home', icon: Home, route: { name: 'home' } },
  { key: 'library', label: 'Library', icon: Library, route: { name: 'library' } },
  { key: 'record', label: 'Record', icon: Mic, route: { name: 'record' } },
  { key: 'studio', label: 'AI Studio', icon: Sparkles, route: { name: 'studio' } },
  { key: 'settings', label: 'Settings', icon: Settings, route: { name: 'settings' } },
];

/**
 * The EchoMind mark, the "echo quote": a quotation mark (what was said) followed by its fainter echo (what
 * EchoMind keeps). The same drawing as the app icon (scripts/make-icon.mjs), but in the theme's accent so
 * it follows the person's colour choice.
 */
export const QUOTE_PATH = 'M21 19.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM28.5 27c0 10.5-5.6 17-14 19.5l-1.4-4.2c5-1.9 7.9-5.6 8.4-10.8z';

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="brand-mark">
      <rect width="64" height="64" rx="16" fill="var(--primary)" />
      <path d={QUOTE_PATH} fill="var(--on-primary)" />
      <path d={QUOTE_PATH} fill="var(--on-primary)" opacity="0.6" transform="translate(20 0)" />
    </svg>
  );
}

export function Shell({ children, footer, sidebarExtra }: { children: ReactNode; footer?: ReactNode; sidebarExtra?: ReactNode }) {
  const { section, switchTo, canGoBack, back, go, route } = useRouter();

  // Ctrl+K searches from anywhere, as in other desktop apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (route.name !== 'search') go({ name: 'search' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, route.name]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar-brand">
          <BrandMark />
          <span>EchoMind</span>
        </div>
        <button type="button" className="sidebar-search" onClick={() => go({ name: 'search' })}>
          <Search size={15} aria-hidden />
          Search
          <kbd>Ctrl K</kbd>
        </button>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <button type="button" className="nav-item" aria-current={section === s.key ? 'page' : undefined} onClick={() => switchTo(s.route)}>
                <s.icon size={18} aria-hidden />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
        {sidebarExtra}
      </nav>
      <div className="main">
        <div className="titlebar">
          {canGoBack && <IconButton icon={ArrowLeft} label="Back (Alt+Left)" onClick={back} className="no-drag" />}
        </div>
        <main className="content">{children}</main>
        {footer}
      </div>
    </div>
  );
}
