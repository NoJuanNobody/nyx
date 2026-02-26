import { DiffView } from './DiffView';

interface AIEditReviewProps {
  originalContent: string;
  proposedContent: string;
  onApprove: () => void;
  onReject: () => void;
}

export function AIEditReview({
  originalContent,
  proposedContent,
  onApprove,
  onReject,
}: AIEditReviewProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 bg-amber-50 px-4 py-2">
        <span className="text-xs font-semibold text-amber-800">
          AI suggested changes
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReject}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700"
          >
            Approve
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <DiffView
          oldText={originalContent}
          newText={proposedContent}
          oldLabel="Current"
          newLabel="AI Suggestion"
        />
      </div>
    </div>
  );
}
