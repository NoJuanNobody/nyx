import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
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
  const [error, setError] = useState<string | null>(null);

  const scanMutation = useMutation({
    mutationFn: () => scanRepository(owner, repo, currentTeamId ?? undefined),
    onSuccess: (data) => {
      onResult(data);
      onClose();
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
            <li>Analyze up to 20 doc-relevant source files</li>
            <li>Generate a documentation draft using AI</li>
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

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={scanMutation.isPending}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(result.suggestedDocs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="scan-result-modal-backdrop"
    >
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl bg-white shadow-2xl" data-testid="scan-result-modal">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Scan Results</h2>
            <p className="text-sm text-slate-500">
              {owner}/{repo} — {result.files.length} file{result.files.length !== 1 ? 's' : ''} analyzed
            </p>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            data-testid="scan-result-copy"
          >
            {copied ? 'Copied!' : 'Copy Markdown'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <pre className="whitespace-pre-wrap text-sm text-slate-700 leading-relaxed font-mono">
            {result.suggestedDocs}
          </pre>
        </div>

        <div className="border-t border-slate-100 px-6 py-4 flex justify-end">
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
