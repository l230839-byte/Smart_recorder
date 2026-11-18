import { Loading } from './design/components';
import { Collections } from './features/collections/Collections';
import { ChatScreen } from './features/chat/ChatScreen';
import { SearchScreen } from './features/chat/SearchScreen';
import { DocumentEditor } from './features/documents/DocumentEditor';
import { StudioOutputScreen } from './features/studio/StudioOutputScreen';
import { StudioTool } from './features/studio/StudioTool';
import { TasksScreen } from './features/tasks/TasksScreen';
import { DocumentsScreen } from './features/documents/DocumentsScreen';
import { NewDocument } from './features/documents/NewDocument';
import { Home } from './features/home/Home';
import { ImportScreen } from './features/library/ImportScreen';
import { Library } from './features/library/Library';
import { PlayerScreen } from './features/library/PlayerScreen';
import { RecordingDetail } from './features/library/RecordingDetail';
import { Storage } from './features/library/Storage';
import { Onboarding } from './features/onboarding/Onboarding';
import { RecordScreen } from './features/record/RecordScreen';
import { Settings } from './features/settings/Settings';
import { Studio } from './features/studio/Studio';
import { SummariesScreen } from './features/summary/SummariesScreen';
import { JobsScreen } from './features/transcript/JobsScreen';
import { ProvidersScreen, UsageScreen } from './features/transcript/ProvidersScreen';
import { TranscriptScreen } from './features/transcript/TranscriptScreen';
import { api, useQuery } from './lib/api';
import { RouterProvider, useRouter } from './lib/router';
import { ToastProvider } from './lib/toast';
import { DropTarget, GlobalEvents, MiniPlayer, RecordingIndicator } from './shell/Overlays';
import { ErrorBoundary } from './shell/ErrorBoundary';
import { Shell } from './shell/Shell';

function Screen() {
  const { route } = useRouter();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'library':
      return <Library key={route.collectionId ?? 'all'} collectionId={route.collectionId} />;
    case 'record':
      return <RecordScreen />;
    case 'studio':
      return <Studio key={route.recordingId ?? ''} recordingId={route.recordingId} />;
    case 'settings':
      return <Settings />;
    case 'recording':
      return <RecordingDetail key={route.id} id={route.id} startMs={route.startMs} />;
    case 'player':
      return <PlayerScreen key={route.id} id={route.id} />;
    case 'import':
      return <ImportScreen />;
    case 'collections':
      return <Collections />;
    case 'storage':
      return <Storage />;
    case 'transcript':
      return <TranscriptScreen key={route.id} id={route.id} startMs={route.startMs} />;
    case 'jobs':
      return <JobsScreen />;
    case 'providers':
      return <ProvidersScreen />;
    case 'usage':
      return <UsageScreen />;
    case 'summaries':
      return <SummariesScreen key={route.id} id={route.id} preset={route.preset} scope={route.scope} />;
    case 'document-new':
      return <NewDocument {...route} />;
    case 'document':
      return <DocumentEditor key={route.id} id={route.id} exportAs={route.exportAs} />;
    case 'documents':
      return <DocumentsScreen />;
    case 'chat':
      return <ChatScreen key={route.threadId ?? JSON.stringify(route.scope ?? null)} threadId={route.threadId} scope={route.scope} />;
    case 'search':
      return <SearchScreen text={route.text} />;
    case 'studio-tool':
      return <StudioTool key={`${route.kind}:${route.recordingIds?.join() ?? ''}`} kind={route.kind} recordingIds={route.recordingIds} />;
    case 'studio-output':
      return <StudioOutputScreen key={route.id} id={route.id} />;
    case 'tasks':
      return <TasksScreen />;
  }
}

function ScreenWithBoundary() {
  const { route } = useRouter();
  return (
    <ErrorBoundary resetKey={route}>
      <Screen />
    </ErrorBoundary>
  );
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
          <Shell footer={<MiniPlayer />} sidebarExtra={<RecordingIndicator />}>
            <ScreenWithBoundary />
          </Shell>
          <DropTarget />
          <GlobalEvents />
        </RouterProvider>
      )}
    </ToastProvider>
  );
}
