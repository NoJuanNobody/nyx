import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Modal } from './Modal';
import { listOtterTranscripts, importOtterTranscript } from '../lib/api';

export interface OtterImportResult {
  title: string;
  content: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /** Called when a transcript has been successfully imported. */
  onImport: (result: OtterImportResult) => void;
}

export function ImportOtterModal({ open, onClose, teamId, onImport }: Props) {
  const [query, setQuery] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['otter-transcripts', teamId, query],
    queryFn: () => listOtterTranscripts(teamId, query || undefined),
    enabled: open,
    // Retry once — if it fails twice the integration is likely not connected
    retry: 1,
  });

  const importMutation = useMutation({
    mutationFn: ({ speechId }: { speechId: string }) =>
      importOtterTranscript(teamId, speechId),
    onMutate: ({ speechId }) => {
      setImportingId(speechId);
      setError(null);
    },
    onSuccess: (result) => {
      setImportingId(null);
      onImport({ title: result.title, content: result.content });
      onClose();
    },
    onError: (err) => {
      setImportingId(null);
      setError(err instanceof Error ? err.message : 'Import failed');
    },
  });

  const notConnected =
    isError ||
    (data as { error?: string } | undefined)?.error?.includes('not found');

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function formatDate(isoOrUnix: string | number): string {
    const date =
      typeof isoOrUnix === 'number'
        ? new Date(isoOrUnix * 1000)
        : new Date(isoOrUnix);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Import from Otter.ai">
      {notConnected ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Connect your Otter.ai account to import transcriptions directly into
            Nyx.
          </p>
          <a
            href={`/api/integrations/otter/connect?teamId=${encodeURIComponent(teamId)}`}
            className="block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            Connect Otter.ai
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Search */}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcripts..."
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          {/* Transcript list */}
          <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-slate-400">
                Loading transcripts...
              </div>
            ) : !data?.speeches || data.speeches.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-slate-400">
                No transcripts found.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.speeches.map((speech) => (
                  <li
                    key={speech.speech_id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    {/* Otter mic icon */}
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-50">
                      <svg
                        className="h-4 w-4 text-blue-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
                        />
                      </svg>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {speech.title || 'Untitled Transcript'}
                      </p>
                      <p className="text-xs text-slate-400">
                        {formatDate(speech.start_time || speech.create_time)}
                        {speech.duration
                          ? ` · ${formatDuration(speech.duration)}`
                          : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        importMutation.mutate({ speechId: speech.speech_id })
                      }
                      disabled={importingId !== null}
                      className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      {importingId === speech.speech_id ? 'Importing...' : 'Import'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-slate-400">
            Transcripts are imported and processed through Nyx's AI pipeline to
            extract decisions, action items, and code references.
          </p>
        </div>
      )}
    </Modal>
  );
}
