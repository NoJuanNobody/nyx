import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchGitHubRepos, saveSelectedRepos } from '../lib/api';
import { Portal } from './Portal';

interface RepoPickerModalProps {
  integrationId: string;
  initialSelected?: Array<{ owner: string; name: string; fullName: string }>;
  onClose: () => void;
}

export function RepoPickerModal({ integrationId, initialSelected = [], onClose }: RepoPickerModalProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialSelected.map((r) => r.fullName)),
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['github-repos', integrationId],
    queryFn: () => fetchGitHubRepos(integrationId),
  });

  const repos = data?.repos ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos, search]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const selectedRepos = repos
        .filter((r) => selected.has(r.full_name))
        .map((r) => {
          const [owner, name] = r.full_name.split('/');
          return { owner, name, fullName: r.full_name };
        });
      return saveSelectedRepos(integrationId, selectedRepos);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
    },
  });

  const toggle = (fullName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.full_name)));
    }
  };

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-800">Select Repositories</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Choose which repos to monitor for code-doc drift detection.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search + select all */}
        <div className="border-b border-slate-100 px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              {selected.size === filtered.length ? 'Deselect All' : 'Select All'}
            </button>
            <span className="text-xs text-slate-400">
              {selected.size} selected
            </span>
          </div>
        </div>

        {/* Repo list */}
        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            </div>
          ) : isError ? (
            <div className="py-8 text-center text-xs text-red-500">
              Failed to load repositories. Check your GitHub connection.
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {search ? 'No repos match your search.' : 'No repositories found.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((repo) => (
                <li key={repo.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-5 py-2.5 hover:bg-slate-50 transition-colors">
                    <input
                      type="checkbox"
                      checked={selected.has(repo.full_name)}
                      onChange={() => toggle(repo.full_name)}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-slate-700">{repo.full_name}</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                          repo.private
                            ? 'bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-200'
                            : 'bg-green-50 text-green-600 ring-1 ring-inset ring-green-200'
                        }`}>
                          {repo.private ? 'Private' : 'Public'}
                        </span>
                        <span className="text-[10px] text-slate-400">{repo.default_branch}</span>
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saveMutation.isPending ? 'Saving...' : `Save (${selected.size} repos)`}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
