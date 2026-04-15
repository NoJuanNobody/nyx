import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Document } from '@nyx/shared';
import { fetchRecentDocuments, fetchTeams } from '../lib/api';

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-slate-100 text-slate-600',
};

export function RecentDocuments() {
  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;

  const { data: documents, isLoading } = useQuery<Document[]>({
    queryKey: ['recent-documents', teamId],
    queryFn: () => fetchRecentDocuments(teamId!, 5),
    enabled: !!teamId,
  });

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-slate-400">Loading recent documents...</div>;
  }

  if (!documents || documents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">No documents yet. Create one to get started!</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Recent Documents</h2>
        <Link
          to="/app/documents"
          className="text-xs font-medium text-blue-600 transition-colors hover:text-blue-700"
        >
          View all
        </Link>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Link
                to={`/app/documents/${doc.id}`}
                className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {doc.title || 'Untitled'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Updated{' '}
                    {new Date(doc.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                </div>
                <span
                  className={`ml-4 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[doc.status] ?? 'bg-slate-100 text-slate-600'}`}
                >
                  {doc.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
