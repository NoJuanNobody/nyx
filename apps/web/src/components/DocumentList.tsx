import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document } from '@nyx/shared';
import {
  fetchDocuments,
  createDocument,
  fetchTeams,
  generateAllDocuments,
} from '../lib/api';
import type { GenerateAllResponse } from '../lib/api';

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-slate-100 text-slate-600',
};

export function DocumentList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [generateAllResult, setGenerateAllResult] = useState<GenerateAllResponse | null>(null);

  const { data: teams, isLoading: teamsLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;

  const { data: documents, isLoading: docsLoading } = useQuery<Document[]>({
    queryKey: ['documents', teamId],
    queryFn: () => fetchDocuments(teamId!),
    enabled: !!teamId,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createDocument({
        title: 'Untitled Document',
        content: '',
        teamId: teamId!,
      }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      navigate(`/documents/${doc.id}`);
    },
  });

  const generateAllMutation = useMutation({
    mutationFn: () => generateAllDocuments(teamId!),
    onSuccess: (result) => {
      setGenerateAllResult(result);
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
    },
  });

  const isLoading = teamsLoading || docsLoading;

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        Loading documents...
      </div>
    );
  }

  if (!documents || documents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <svg
          className="mx-auto h-12 w-12 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
          />
        </svg>
        <h3 className="mt-4 text-sm font-semibold text-slate-900">
          No documents yet
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Get started by creating your first document.
        </p>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          {createMutation.isPending ? 'Creating...' : 'New Document'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="generate-all-btn"
          onClick={() => {
            setGenerateAllResult(null);
            generateAllMutation.mutate();
          }}
          disabled={generateAllMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-100 disabled:opacity-50 transition-colors"
        >
          {generateAllMutation.isPending ? (
            <>
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
              Generating All...
            </>
          ) : (
            <>
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                />
              </svg>
              Generate All
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          {createMutation.isPending ? 'Creating...' : 'New Document'}
        </button>
      </div>

      {generateAllMutation.isError && (
        <div
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          data-testid="generate-all-error"
        >
          Failed to generate documentation. Please try again.
        </div>
      )}

      {generateAllResult && (
        <div
          className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          data-testid="generate-all-result"
        >
          <p className="font-medium">
            Generation complete: {generateAllResult.succeeded} of{' '}
            {generateAllResult.total} documents generated successfully.
          </p>
          {generateAllResult.failed > 0 && (
            <p className="mt-1 text-green-700">
              {generateAllResult.failed} document(s) failed to generate.
            </p>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Link
                to={`/documents/${doc.id}`}
                className="flex items-center justify-between px-5 py-4 transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {doc.title || 'Untitled'}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Updated{' '}
                    {new Date(doc.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
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
