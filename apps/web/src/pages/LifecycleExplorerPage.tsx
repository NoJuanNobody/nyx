import { useSearchParams, useNavigate } from 'react-router-dom';
import { LifecycleExplorer } from '../components/LifecycleExplorer';

export function LifecycleExplorerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isOnboarding = searchParams.get('onboarding') === '1';

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <LifecycleExplorer
        mode={isOnboarding ? 'onboarding' : 'dashboard'}
        onComplete={isOnboarding ? () => navigate('/app/dashboard') : undefined}
      />
    </div>
  );
}
