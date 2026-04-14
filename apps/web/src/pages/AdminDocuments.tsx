import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchAdminDocuments } from '../lib/api';
import type { AdminDocumentListItem } from '@nyx/shared';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  published: 'bg-green-50 text-green-700',
  archived: 'bg-red-50 text-red-600',
};

export function AdminDocuments() {
  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-documents'],
    queryFn: fetchAdminDocuments,
  });

  const teams = data?.teams ?? [];
  const allDocs = data?.documents ?? [];

  const filtered = useMemo(() => {
    let docs: AdminDocumentListItem[] = allDocs;
    if (teamFilter) docs = docs.filter((d) => d.teamId === teamFilter);
    if (statusFilter) docs = docs.filter((d) => d.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      docs = docs.filter((d) => d.title.toLowerCase().includes(q));
    }
    return docs;
  }, [allDocs, teamFilter, statusFilter, search]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-slate-400">Loading all documents…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Failed to load documents'}
        </div>
      </div>
    );
  }

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">All Documents</h1>
          <p className="mt-1 text-sm text-slate-500">
            Documents across all teams where you have admin or owner access.
          </p>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by team"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.teamName}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>

          <input
            type="search"
            placeholder="Search by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-48 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            data-testid="admin-docs-search"
          />

          <span className="ml-auto text-xs text-slate-400">
            {filtered.length} document{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Documents table */}
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-slate-500">No documents match the current filters.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid="admin-docs-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Team</th>
                  <th className="px-4 py-3">Author</th>
                  <th className="px-4 py-3">Stage</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((doc, idx) => (
                  <tr
                    key={doc.id}
                    className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${
                      idx === filtered.length - 1 ? 'border-b-0' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-medium text-slate-800">
                      <Link
                        to={`/app/documents/${doc.id}`}
                        className="hover:text-blue-600 transition-colors"
                        data-testid={`admin-doc-link-${doc.id}`}
                      >
                        {doc.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                        {doc.teamName}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{doc.createdByName}</td>
                    <td className="px-4 py-3 text-slate-500">{doc.stage ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                          STATUS_BADGE[doc.status] ?? 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                      {timeAgo(doc.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
