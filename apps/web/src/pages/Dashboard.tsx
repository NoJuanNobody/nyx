import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchTeams, createDocument } from '../lib/api';
import { DashboardAIPrompt } from '../components/DashboardAIPrompt';
import { PhaseSuggestions } from '../components/PhaseSuggestions';
import { RecentDocuments } from '../components/RecentDocuments';

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createDocument({
        title: 'Untitled Document',
        content: '',
        teamId: teamId!,
      }),
    onSuccess: (doc) => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/app/documents/${doc.id}`);
    },
    onError: (err: unknown) => {
      setCreateError(err instanceof Error ? err.message : 'Failed to create document.');
    },
  });

  return (
    <>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage your documentation and keep it in sync with your codebase.
          </p>
        </div>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || !teamId}
          title={!teamId ? 'No team available yet — refresh or check your team membership.' : undefined}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:from-blue-600 hover:to-violet-600 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {createMutation.isPending ? 'Creating...' : 'New Document'}
        </button>
      </div>

      {createError && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {createError}
        </div>
      )}

      <div className="space-y-8">
        <Link
          to="/lifecycle"
          className="group flex items-center gap-4 rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4 transition-all hover:border-blue-500/30 hover:bg-white/10 hover:shadow-md"
          data-testid="lifecycle-card"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-lg group-hover:bg-blue-500/20 transition-colors">
            ◎
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">How It Works</h3>
            <p className="text-xs text-slate-500 mt-0.5">Explore the 5-phase product lifecycle — from idea to living codebase</p>
          </div>
          <svg className="h-4 w-4 text-slate-400 group-hover:text-blue-500 transition-colors" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </Link>
        {teamId && <DashboardAIPrompt teamId={teamId} />}
        {teamId && <PhaseSuggestions teamId={teamId} />}
        <RecentDocuments />
      </div>
    </>
  );
}
