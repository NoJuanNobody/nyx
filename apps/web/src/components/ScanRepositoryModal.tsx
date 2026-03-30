import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { scanRepository, type ScanResult } from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

interface ScanRepositoryModalProps {
  owner: string;
  repo: string;
  onClose: () => void;
  onResult: (result: ScanResult) => void;
}

export function ScanRepositoryModal({ owner, repo, onClose, onResult }: ScanRepositoryModalProps) {
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const scanMutation = useMutation({
    mutationFn: () => scanRepository(owner, repo, currentTeamId ?? undefined),
    onSuccess: (data) => {
      // Invalidate documents query so file explorer refreshes
      if (currentTeamId) {
        queryClient.invalidateQueries({ queryKey: ['documents', currentTeamId] });
      }
      onResult(data);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !scanMutation.isPending) onClose();
      }}
      data-testid="scan-repo-modal-backdrop"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" data-testid="scan-repo-modal">
        <h2 className="text-lg font-semibold text-slate-900">Scan Repository</h2>
        <p className="mt-1 text-sm text-slate-500">
          Scan <span className="font-medium text-slate-700">{owner}/{repo}</span> to generate initial documentation from its codebase.
        </p>

        <div className="mt-4 rounded-md bg-blue-50 p-3 text-sm text-blue-700">
          <p>This will:</p>
          <ul className="mt-1 list-disc pl-4 text-xs space-y-0.5">
            <li>Fetch the repository file tree from GitHub</li>
            <li>Analyze source files grouped by module</li>
            <li>Generate documentation per module using AI</li>
            <li>Save documents to your file explorer automatically</li>
          </ul>
        </div>

        {scanMutation.isPending && (
          <div className="mt-4 flex items-center gap-3 rounded-md bg-slate-50 p-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
            <span className="text-sm text-slate-600">Scanning repository and generating docs...</span>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700" data-testid="scan-repo-error">
            {error}
          </div>
        )}

        {scanMutation.isSuccess && scanMutation.data && (
          <div className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700" data-testid="scan-repo-success">
            <p className="font-medium">Documents saved!</p>
            <p className="mt-1 text-xs">
              {scanMutation.data.documents.length} document{scanMutation.data.documents.length !== 1 ? 's' : ''} created
              from {scanMutation.data.fileCount} file{scanMutation.data.fileCount !== 1 ? 's' : ''} across{' '}
              {scanMutation.data.moduleCount} module{scanMutation.data.moduleCount !== 1 ? 's' : ''}.
            </p>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={scanMutation.isPending}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            {scanMutation.isSuccess ? 'Close' : 'Cancel'}
          </button>
          {!scanMutation.isSuccess && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                scanMutation.mutate();
              }}
              disabled={scanMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
              data-testid="scan-repo-submit"
            >
              {scanMutation.isPending ? 'Scanning...' : 'Start Scan'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ScanResultViewProps {
  owner: string;
  repo: string;
  result: ScanResult;
  onClose: () => void;
}

export function ScanResultView({ owner, repo, result, onClose }: ScanResultViewProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="scan-result-modal-backdrop"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" data-testid="scan-result-modal">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
            <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Scan Complete</h2>
            <p className="text-sm text-slate-500">
              {owner}/{repo}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-md bg-green-50 p-3">
          <p className="text-sm font-medium text-green-800">
            {result.documents.length} document{result.documents.length !== 1 ? 's' : ''} saved to file explorer
          </p>
          <p className="mt-1 text-xs text-green-700">
            Analyzed {result.fileCount} file{result.fileCount !== 1 ? 's' : ''} across{' '}
            {result.moduleCount} module{result.moduleCount !== 1 ? 's' : ''}.
          </p>
        </div>

        {result.documents.length > 0 && (
          <div className="mt-3 max-h-48 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
            {result.documents.map((doc) => (
              <div key={doc.id} className="px-3 py-2 text-sm text-slate-700">
                <span className="font-medium">{doc.title}</span>
                <span className="ml-2 text-xs text-slate-400">{doc.path}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
