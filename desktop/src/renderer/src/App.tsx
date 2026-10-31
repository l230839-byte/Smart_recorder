import { Library as LibraryIcon, Mic } from 'lucide-react';
import { EmptyState, Loading } from './design/components';
import { Home } from './features/home/Home';
import { Onboarding } from './features/onboarding/Onboarding';
import { Settings } from './features/settings/Settings';
import { Studio } from './features/studio/Studio';
import { api, useQuery } from './lib/api';
import { RouterProvider, useRouter } from './lib/router';
import { ToastProvider } from './lib/toast';
import { Shell } from './shell/Shell';

function Screen() {
  const { route } = useRouter();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'studio':
      return <Studio />;
    case 'settings':
      return <Settings />;
    case 'record':
      return <EmptyState icon={Mic} title="Recording arrives in Phase 2" message="The foundation is in place. The recorder is next." />;
    default:
      return <EmptyState icon={LibraryIcon} title="The library arrives in Phase 2" message="Your recordings and imports will appear here." />;
  }
}

export function App() {
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  return (
    <ToastProvider>
      {!settings.data ? (
        <Loading />
      ) : !settings.data.onboardingComplete ? (
        <Onboarding onDone={settings.reload} />
      ) : (
        <RouterProvider>
          <Shell>
            <Screen />
          </Shell>
        </RouterProvider>
      )}
    </ToastProvider>
  );
}
