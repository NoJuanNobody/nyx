import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DocumentVersion } from '@syncdocs/shared';
import { fetchVersions } from '../lib/api';

interface VersionHistoryProps {
  documentId: string;
  onCompare?: (versionA: DocumentVersion, versionB: DocumentVersion) => void;
  onExitCompare?: () => void;
}

export function VersionHistory({ documentId, onCompare, onExitCompare }: VersionHistoryProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);

  const { data: versions, isLoading } = useQuery<DocumentVersion[]>({
    queryKey: ['versions', documentId],
    queryFn: () => fetchVersions(documentId),
  });

  const handleVersionClick = (v: DocumentVersion) => {
    if (compareMode) {
      setCompareSelection((prev) => {
        if (prev.includes(v.id)) {
          return prev.filter((id) => id !== v.id);
        }
        if (prev.length >= 2) {
          return [prev[1], v.id];
        }
        return [...prev, v.id];
      });
    } else {
      setSelectedId(v.id === selectedId ? null : v.id);
    }
  };

  const handleCompare = () => {
    if (compareSelection.length === 2 && versions && onCompare) {
      const a = versions.find((v) => v.id === compareSelection[0]);
      const b = versions.find((v) => v.id === compareSelection[1]);
      if (a && b) onCompare(a, b);
    }
  };

  const handleExitCompare = () => {
    setCompareMode(false);
    setCompareSelection([]);
    onExitCompare?.();
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Compare mode toggle */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
        {!compareMode ? (
          <button
            type="button"
            onClick={() => setCompareMode(true)}
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Compare versions
          </button>
        ) : (
          <div className="flex w-full items-center gap-2">
            <button
              type="button"
              onClick={handleCompare}
              disabled={compareSelection.length !== 2}
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              Compare ({compareSelection.length}/2)
            </button>
            <button
              type="button"
              onClick={handleExitCompare}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="p-4 text-sm text-slate-400">Loading versions...</p>
        )}

        {!isLoading && (!versions || versions.length === 0) && (
          <p className="p-4 text-sm text-slate-400">No versions yet.</p>
        )}

        {versions?.map((v) => {
          const isSelected = compareMode
            ? compareSelection.includes(v.id)
            : v.id === selectedId;

          return (
            <button
              key={v.id}
              type="button"
              onClick={() => handleVersionClick(v)}
              className={`w-full border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-slate-50 ${
                isSelected ? 'bg-blue-50' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900">
                  v{v.version}
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
              </div>
              {v.message && (
                <p className="mt-1 truncate text-xs text-slate-500">
                  {v.message}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
