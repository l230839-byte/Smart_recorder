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

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brand-mark">
      <rect width="32" height="32" rx="9" fill="var(--primary)" />
      <g stroke="var(--on-primary)" strokeWidth="2.4" strokeLinecap="round">
        <path d="M8 14v4M12.5 10.5v11M17 7.5v17M21.5 11.5v9M26 14.5v3" />
      </g>
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
