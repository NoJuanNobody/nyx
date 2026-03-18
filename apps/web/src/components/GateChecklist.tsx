import type { GateCheckResult } from '../lib/api';

interface GateChecklistProps {
  result: GateCheckResult;
  targetStageLabel: string;
  /** Called when the user clicks the "Proceed Anyway" override button */
  onOverride?: () => void;
  /** Called when the user dismisses the checklist without advancing */
  onCancel: () => void;
}

/**
 * GateChecklist — shown in the DocumentEditor when a user tries to advance
 * a document to a stage that has unfulfilled gate rules. Displays a checklist
 * of conditions with green checkmarks for met rules and red ✗ for unmet ones.
 */
export function GateChecklist({ result, targetStageLabel, onOverride, onCancel }: GateChecklistProps) {
  const metCount = result.rules.filter((r) => r.met).length;
  const total = result.rules.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            Stage Requirements for&nbsp;
            <span className="text-indigo-600">{targetStageLabel}</span>
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Complete the following requirements before advancing this document.
          </p>
        </div>

        {/* Checklist */}
        <div className="space-y-2 px-6 py-4">
          {result.rules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                rule.met
                  ? 'border-green-200 bg-green-50'
                  : 'border-red-200 bg-red-50'
              }`}
            >
              {/* Icon */}
              {rule.met ? (
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              ) : (
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              )}

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${rule.met ? 'text-green-800' : 'text-red-800'}`}>
                  {rule.label}
                </p>
                {!rule.met && rule.reason && (
                  <p className="mt-0.5 text-xs text-red-600">{rule.reason}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Progress summary */}
        <div className="px-6 pb-2">
          <p className="text-xs text-slate-500">
            {metCount} of {total} requirement{total !== 1 ? 's' : ''} met
          </p>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                metCount === total ? 'bg-green-500' : 'bg-amber-400'
              }`}
              style={{ width: `${total > 0 ? (metCount / total) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 border-t border-slate-100 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          {onOverride && (
            <button
              type="button"
              onClick={onOverride}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 transition-colors"
              title="Advance stage without meeting all requirements"
            >
              Advance Anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
