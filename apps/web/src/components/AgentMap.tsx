import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  updateAgentState,
  enableAgent,
  disableAgent,
  type AgentMapEntry,
} from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

// ── State badge color map ────────────────────────────────────────
const STATE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  idle: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400' },
  joining: { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-400' },
  in_call: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  processing: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  complete: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  error: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
};

function StateBadge({ state }: { state: string }) {
  const colors = STATE_COLORS[state] ?? STATE_COLORS.idle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}
      data-testid={`agent-state-${state}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
      {state.replace('_', ' ')}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentMapEntry }) {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const isEnabled = currentTeamId ? agent.enabledWorkspaces.includes(currentTeamId) : false;

  const toggleMutation = useMutation({
    mutationFn: async () => {
      if (!currentTeamId) return;
      if (isEnabled) {
        await disableAgent(agent.type, currentTeamId);
      } else {
        await enableAgent(agent.type, currentTeamId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-registry'] });
    },
  });

  return (
    <div
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow"
      data-testid={`agent-card-${agent.type}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 truncate">{agent.name}</h3>
          <p className="mt-0.5 text-xs text-slate-400 font-mono">{agent.type}</p>
        </div>
        <StateBadge state={agent.currentState} />
      </div>

      {/* Description */}
      <p className="mt-3 text-xs text-slate-500 leading-relaxed line-clamp-2">
        {agent.description}
      </p>

      {/* Capabilities */}
      <div className="mt-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1.5">
          Capabilities
        </p>
        <div className="flex flex-wrap gap-1">
          {agent.capabilities.map((cap) => (
            <span
              key={cap}
              className="inline-block rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>

      {/* Enable/Disable toggle */}
      {currentTeamId && (
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">
            {isEnabled ? 'Enabled for workspace' : 'Disabled for workspace'}
          </span>
          <button
            type="button"
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              isEnabled ? 'bg-blue-600' : 'bg-slate-200'
            }`}
            data-testid={`agent-toggle-${agent.type}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                isEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentMap({ agents }: { agents: AgentMapEntry[] }) {
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/50 py-16 px-6 text-center">
        <svg
          className="h-10 w-10 text-slate-300 mb-3"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
        <p className="text-sm font-medium text-slate-700">No agents registered</p>
        <p className="mt-1 text-xs text-slate-400">Agents will appear here once configured.</p>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="agent-map-grid"
    >
      {agents.map((agent) => (
        <AgentCard key={agent.type} agent={agent} />
      ))}
    </div>
  );
}
