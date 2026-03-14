import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchTeams, findContextMatches } from '../lib/api';
import type { ContextMatchResult } from '../lib/api';
import { ContextMatches } from '../components/ContextMatches';

export function IntakePage() {
  const [rawInput, setRawInput] = useState('');
  const [contextResult, setContextResult] = useState<ContextMatchResult | null>(null);

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;

  const contextMutation = useMutation({
    mutationFn: (input: string) =>
      findContextMatches({ rawInput: input, teamId: teamId! }),
    onSuccess: (data) => {
      setContextResult(data);
    },
  });

  const handleProcess = () => {
    if (!rawInput.trim() || !teamId) return;
    contextMutation.mutate(rawInput);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Chaos Ingestion</h1>
        <p className="mt-1 text-sm text-slate-500">
          Paste raw input -- meeting notes, Slack threads, emails -- and Nyx will cross-reference
          it against your spec history.
        </p>
      </div>

      <div className="space-y-4">
        <textarea
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          placeholder="Paste your raw input here..."
          rows={8}
          className="w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          data-testid="intake-raw-input"
        />

        <button
          type="button"
          onClick={handleProcess}
          disabled={!rawInput.trim() || !teamId || contextMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          data-testid="intake-process-btn"
        >
          {contextMutation.isPending ? 'Analyzing...' : 'Analyze Context'}
        </button>

        {contextMutation.isError && (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            data-testid="intake-error"
          >
            Failed to analyze context. Please try again.
          </div>
        )}

        {/* Context matches section */}
        {contextMutation.isPending && (
          <ContextMatches matches={[]} signals={[]} isLoading />
        )}

        {contextResult && !contextMutation.isPending && (
          <ContextMatches
            matches={contextResult.matches}
            signals={contextResult.signals}
          />
        )}
      </div>
    </div>
  );
}
