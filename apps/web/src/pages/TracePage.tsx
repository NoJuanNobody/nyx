import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchDocument } from '../lib/api';
import { TraceView } from '../components/TraceView';

export function TracePage() {
  const { id } = useParams<{ id: string }>();

  const { data: doc } = useQuery({
    queryKey: ['document', id],
    queryFn: () => fetchDocument(id!),
    enabled: !!id,
  });

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        No document ID provided.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <Link
          to={`/app/documents/${id}`}
          className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors hover:text-slate-600"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
            />
          </svg>
          Back to document
        </Link>
        <h1 className="text-xl font-bold text-slate-900">
          {doc?.title ?? 'Document'} &mdash; Trace
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Traceability view showing how this document moved from intent to implementation.
        </p>
      </div>

      {/* Trace */}
      <TraceView documentId={id} />
    </div>
  );
}
