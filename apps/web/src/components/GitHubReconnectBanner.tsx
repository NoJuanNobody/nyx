import { useAuthStore } from '../stores/auth.store';
import { API_BASE } from '../lib/api';

export function GitHubReconnectBanner({ onDismiss }: { onDismiss?: () => void }) {
  const currentTeamId = useAuthStore((s) => s.currentTeamId);

  const handleReconnect = () => {
    if (currentTeamId) {
      window.location.href = `${API_BASE}/integrations/github/connect?teamId=${currentTeamId}`;
    }
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <svg className="h-5 w-5 flex-shrink-0 text-amber-500 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-800">GitHub connection expired</h3>
          <p className="mt-0.5 text-xs text-amber-700">
            Your GitHub token has expired or been revoked. Reconnect to continue using GitHub features.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleReconnect}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-amber-700 transition-colors"
            >
              Reconnect GitHub
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 transition-colors"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
