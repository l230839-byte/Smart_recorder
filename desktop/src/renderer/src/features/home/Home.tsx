import { useRouter } from '../../lib/router';
import { Button, PageHeader } from '../../design/components';
import { api, useQuery } from '../../lib/api';

function greeting(name: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

export function Home() {
  const { switchTo } = useRouter();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  return (
    <div className="page">
      <PageHeader title={greeting(settings.data?.displayName ?? '')} subtitle="Turn every recording into knowledge, documents and action." />
      <div className="row">
        <Button variant="tonal" onClick={() => switchTo({ name: 'studio' })}>
          See what is coming in AI Studio
        </Button>
      </div>
    </div>
  );
}
