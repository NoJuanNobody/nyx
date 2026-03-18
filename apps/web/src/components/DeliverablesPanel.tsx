import { useState, useEffect, useCallback } from 'react';
import {
  fetchDeliverables,
  generateDeliverables,
  deleteDeliverable,
  getDeliverableDownloadUrl,
  type Deliverable,
} from '../lib/api';

interface DeliverablesPanelProps {
  documentId: string;
  currentStage?: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  markdown: 'Markdown Export',
  ai_report: 'AI-Polished Report',
  structured_export: 'Structured Export (JSON)',
};

const TYPE_ICONS: Record<string, string> = {
  markdown: '📄',
  ai_report: '✨',
  structured_export: '🗂',
};

const STATUS_COLORS: Record<string, string> = {
  ready: 'text-green-600 bg-green-50',
  generating: 'text-amber-600 bg-amber-50',
  pending: 'text-slate-500 bg-slate-50',
  failed: 'text-red-600 bg-red-50',
};

function DeliverableRow({
  item,
  documentId,
  onDelete,
}: {
  item: Deliverable;
  documentId: string;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteDeliverable(documentId, item.id);
      onDelete(item.id);
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg border border-slate-100 bg-white hover:bg-slate-50 transition-colors">
      <span className="text-lg">{TYPE_ICONS[item.type] ?? '📁'}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 truncate">
          {TYPE_LABELS[item.type] ?? item.type}
        </p>
        <p className="text-xs text-slate-500 truncate">{item.fileName || '—'}</p>
        {item.generatedAt && (
          <p className="text-xs text-slate-400">
            {new Date(item.generatedAt).toLocaleString()}
          </p>
        )}
      </div>
      <span
        className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[item.status] ?? 'text-slate-500 bg-slate-50'}`}
      >
        {item.status === 'generating' ? (
          <span className="flex items-center gap-1">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            generating
          </span>
        ) : (
          item.status
        )}
      </span>
      {item.status === 'ready' && (
        <a
          href={getDeliverableDownloadUrl(documentId, item.id)}
          download={item.fileName}
          className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-800 underline"
        >
          Download
        </a>
      )}
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="shrink-0 text-slate-400 hover:text-red-500 disabled:opacity-40 transition-colors"
        title="Delete deliverable"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function DeliverablesPanel({ documentId, currentStage }: DeliverablesPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [items, setItems] = useState<Deliverable[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDeliverables(documentId);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deliverables');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any item is generating
  useEffect(() => {
    const hasGenerating = items.some((i) => i.status === 'generating' || i.status === 'pending');
    if (!hasGenerating) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [items, load]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const data = await generateDeliverables(documentId);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const stageItems = currentStage ? items.filter((i) => i.stage === currentStage) : items;
  const otherItems = currentStage ? items.filter((i) => i.stage !== currentStage) : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-slate-50 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">🗃</span>
          <span className="text-sm font-semibold text-slate-800">Deliverables</span>
          {items.length > 0 && (
            <span className="text-xs font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full">
              {items.length}
            </span>
          )}
        </div>
        <svg
          className={`h-4 w-4 text-slate-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3">
          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={generating || loading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Generating deliverables…
              </>
            ) : (
              <>
                <span>✨</span>
                Generate deliverables for this stage
              </>
            )}
          </button>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          {loading && items.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-2">Loading…</p>
          )}

          {/* Current stage deliverables */}
          {stageItems.length > 0 && (
            <div className="space-y-1.5">
              {currentStage && (
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Current stage: {currentStage}
                </p>
              )}
              {stageItems.map((item) => (
                <DeliverableRow
                  key={item.id}
                  item={item}
                  documentId={documentId}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          {/* Previous stage deliverables */}
          {otherItems.length > 0 && (
            <details className="group">
              <summary className="text-xs font-semibold text-slate-400 uppercase tracking-wide cursor-pointer hover:text-slate-600 list-none flex items-center gap-1">
                <svg className="h-3 w-3 group-open:rotate-90 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Previous stages ({otherItems.length})
              </summary>
              <div className="mt-1.5 space-y-1.5">
                {otherItems.map((item) => (
                  <DeliverableRow
                    key={item.id}
                    item={item}
                    documentId={documentId}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </details>
          )}

          {!loading && items.length === 0 && !error && (
            <p className="text-xs text-slate-400 text-center py-2">
              No deliverables yet. Generate them above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
