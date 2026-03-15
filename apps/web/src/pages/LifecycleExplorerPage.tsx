import { useSearchParams, useNavigate } from 'react-router-dom';
import { LifecycleExplorer } from '../components/LifecycleExplorer';

export function LifecycleExplorerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isOnboarding = searchParams.get('onboarding') === '1';

  return (
    <LifecycleExplorer
      mode={isOnboarding ? 'onboarding' : 'dashboard'}
      onComplete={isOnboarding ? () => navigate('/dashboard') : undefined}
    />
  );
}
