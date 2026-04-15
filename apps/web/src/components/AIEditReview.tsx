import { useState } from 'react';
import { DiffView } from './DiffView';

type ReviewMode = 'diff' | 'edit';

interface AIEditReviewProps {
  originalContent: string;
  proposedContent: string;
  onApprove: (editedContent?: string) => void;
  onReject: () => void;
}

export function AIEditReview({
  originalContent,
  proposedContent,
  onApprove,
  onReject,
}: AIEditReviewProps) {
  const [mode, setMode] = useState<ReviewMode>('diff');
  const [editedContent, setEditedContent] = useState(proposedContent);
  const hasEdits = editedContent !== proposedContent;

  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-testid="ai-edit-review"
    >
      <div className="flex flex-wrap items-center justify-between gap-y-2 border-b border-slate-200 bg-amber-50 px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-xs font-semibold text-amber-800">
            AI suggested changes
          </span>
          <div className="flex rounded-md border border-amber-200 bg-white">
            <button
              type="button"
              onClick={() => setMode('diff')}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                mode === 'diff'
                  ? 'bg-amber-100 text-amber-800'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Diff
            </button>
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                mode === 'edit'
                  ? 'bg-amber-100 text-amber-800'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Edit
            </button>
          </div>
          {hasEdits && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
              Modified
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onReject}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onApprove(hasEdits ? editedContent : undefined)}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700"
          >
            Approve{hasEdits ? ' (edited)' : ''}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {mode === 'diff' ? (
          <DiffView
            oldText={originalContent}
            newText={hasEdits ? editedContent : proposedContent}
            oldLabel="Current"
            newLabel={hasEdits ? 'Edited' : 'AI Suggestion'}
          />
        ) : (
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="h-full w-full resize-none p-4 font-mono text-sm text-slate-800 outline-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
