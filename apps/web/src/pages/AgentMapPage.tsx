import { useQuery } from '@tanstack/react-query';
import { fetchAgentRegistry } from '../lib/api';
import { AgentMap } from '../components/AgentMap';

export function AgentMapPage() {
  const {
    data: agents,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['agent-registry'],
    queryFn: fetchAgentRegistry,
  });

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">AI Agent Map</h1>
        <p className="mt-1 text-sm text-slate-500">
          View and manage all registered AI agents. Monitor their state, capabilities, and
          workspace availability.
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-center">
          <p className="text-sm font-medium text-red-700">Failed to load agent registry</p>
          <p className="mt-1 text-xs text-red-500">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </div>
      )}

      {/* Agent grid */}
      {agents && <AgentMap agents={agents} />}
    </div>
    </div>
  );
}
