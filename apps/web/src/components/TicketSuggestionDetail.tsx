import { useState, useCallback, useEffect, useRef } from 'react';
import { MarkdownPreview } from './MarkdownPreview';
import type { TicketSuggestion } from '../lib/api';

interface TicketSuggestionDetailProps {
  suggestion: TicketSuggestion | null;
  onClose: () => void;
  onSave: (id: string, updates: { title?: string; description?: string }) => void;
  onDismiss: (id: string) => void;
  onApprove: (id: string) => void;
  isSaving?: boolean;
}

export function TicketSuggestionDetail({
  suggestion,
  onClose,
  onSave,
  onDismiss,
  onApprove,
  isSaving,
}: TicketSuggestionDetailProps) {
  const isOpen = suggestion !== null;
  const drawerRef = useRef<HTMLDivElement>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Reset edit state when suggestion changes
  useEffect(() => {
    if (suggestion) {
      setEditTitle(suggestion.title);
      setEditDescription(suggestion.description);
      setIsEditing(false);
    }
  }, [suggestion]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const startEditing = useCallback(() => {
    if (!suggestion || suggestion.status !== 'pending') return;
    setIsEditing(true);
  }, [suggestion]);

  const cancelEditing = useCallback(() => {
    if (suggestion) {
      setEditTitle(suggestion.title);
      setEditDescription(suggestion.description);
    }
    setIsEditing(false);
  }, [suggestion]);

  const saveEdits = useCallback(() => {
    if (!suggestion) return;
    const updates: { title?: string; description?: string } = {};
    if (editTitle !== suggestion.title) updates.title = editTitle;
    if (editDescription !== suggestion.description) updates.description = editDescription;
    if (Object.keys(updates).length > 0) {
      onSave(suggestion.id, updates);
    }
    setIsEditing(false);
  }, [suggestion, editTitle, editDescription, onSave]);

  if (!suggestion) return null;

  const isPending = suggestion.status === 'pending';
  const isApproved = suggestion.status === 'approved';
  const isDismissed = suggestion.status === 'dismissed';

  return (
    <div
      ref={drawerRef}
      className={`flex flex-shrink-0 flex-col border-l border-slate-200/80 bg-white transition-all duration-200 ease-out ${
        isOpen ? 'w-[420px]' : 'w-0'
      }`}
      style={{ overflow: isOpen ? undefined : 'hidden' }}
    >
      {isOpen && (
        <div className="flex h-full w-[420px] flex-col">
          {/* Header */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200/80 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              Ticket Detail
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close detail panel"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* Status badge + labels row */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  isPending
                    ? 'bg-yellow-50 text-yellow-700'
                    : isApproved
                      ? 'bg-green-50 text-green-700'
                      : isDismissed
                        ? 'bg-slate-100 text-slate-500'
                        : 'bg-slate-100 text-slate-500'
                }`}
              >
                {suggestion.status}
              </span>
              {suggestion.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                >
                  {label}
                </span>
              ))}
            </div>

            {/* Title */}
            <div className="mb-4">
              {isEditing ? (
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                  className="w-full rounded-md border border-blue-300 px-3 py-2 text-base font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-blue-100"
                />
              ) : (
                <h3 className="text-base font-semibold text-slate-900">{suggestion.title}</h3>
              )}
            </div>

            {/* Description */}
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Description
              </div>
              {isEditing ? (
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={16}
                  className="w-full rounded-md border border-blue-300 px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-blue-100 font-mono"
                />
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
                  <MarkdownPreview content={suggestion.description} />
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex flex-shrink-0 items-center gap-2 border-t border-slate-200/80 px-4 py-3 bg-slate-50">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={saveEdits}
                  disabled={isSaving}
                  className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {isPending && (
                  <>
                    <button
                      type="button"
                      onClick={() => onApprove(suggestion.id)}
                      className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                    >
                      Create Ticket
                    </button>
                    <button
                      type="button"
                      onClick={startEditing}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => onDismiss(suggestion.id)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 hover:border-red-200"
                    >
                      Dismiss
                    </button>
                  </>
                )}
                {!isPending && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Close
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
