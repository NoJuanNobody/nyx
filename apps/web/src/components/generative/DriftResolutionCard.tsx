/**
 * DriftResolutionCard — generative UI component for spec-to-code drift resolution.
 *
 * The model streams props into this card via the Hashbrown/AG-UI TOOL_CALL_ARGS
 * events. Users can accept or decline the recommendation directly from the card.
 */
import { useState } from 'react';

export interface DriftResolutionCardProps {
  /** Short human-readable summary of what drifted */
  summary: string;
  /** The spec snippet that is out of sync */
  specSnippet?: string;
  /** The code snippet that diverged */
  codeSnippet?: string;
  /** Severity level */
  severity?: 'low' | 'medium' | 'high';
  /** Suggested action labels (e.g. "Update Spec to Match Code") */
  recommendations?: string[];
  /** Called when the user picks a recommendation */
  onAction?: (action: string) => void;
  /** Called when the user snoozes/ignores this drift */
  onSnooze?: () => void;
}

const SEVERITY_STYLES = {
  low: { badge: 'bg-yellow-100 text-yellow-700', border: 'border-yellow-200' },
  medium: { badge: 'bg-orange-100 text-orange-700', border: 'border-orange-300' },
  high: { badge: 'bg-red-100 text-red-700', border: 'border-red-300' },
} as const;

export function DriftResolutionCard({
  summary,
  specSnippet,
  codeSnippet,
  severity = 'medium',
  recommendations = ['Update Spec to Match Code', 'Generate PR to Match Spec', 'Snooze'],
  onAction,
  onSnooze,
}: DriftResolutionCardProps) {
  const [resolved, setResolved] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const styles = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.medium;

  if (resolved) {
    return (
      <div
        className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500"
        data-testid="drift-resolution-card-resolved"
      >
        ✓ Drift resolved — <span className="font-medium">{chosen}</span>
      </div>
    );
  }

  function handleAction(action: string) {
    setChosen(action);
    setResolved(true);
    if (action.toLowerCase().includes('snooze')) {
      onSnooze?.();
    } else {
      onAction?.(action);
    }
  }

  return (
    <div
      className={`rounded-lg border ${styles.border} bg-white shadow-sm`}
      data-testid="drift-resolution-card"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base">⚠</span>
          <span className="text-sm font-medium text-slate-800">Spec Drift Detected</span>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles.badge}`}
          data-testid="drift-severity-badge"
        >
          {severity}
        </span>
      </div>

      {/* Summary */}
      <div className="border-t border-slate-100 px-4 py-3 text-sm text-slate-700">{summary}</div>

      {/* Diff view */}
      {(specSnippet || codeSnippet) && (
        <div className="grid grid-cols-2 gap-0 border-t border-slate-100">
          {specSnippet && (
            <div className="px-4 py-3" data-testid="drift-spec-snippet">
              <div className="mb-1 text-xs font-medium text-slate-400 uppercase tracking-wide">Spec</div>
              <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap">
                {specSnippet}
              </pre>
            </div>
          )}
          {codeSnippet && (
            <div className="border-l border-slate-100 px-4 py-3" data-testid="drift-code-snippet">
              <div className="mb-1 text-xs font-medium text-slate-400 uppercase tracking-wide">Code</div>
              <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap">
                {codeSnippet}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">
        {recommendations.map((action) => {
          const isSnooze = action.toLowerCase().includes('snooze') || action.toLowerCase().includes('ignore');
          return (
            <button
              key={action}
              onClick={() => handleAction(action)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                isSnooze
                  ? 'border border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
              data-testid={`drift-action-${action.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {action}
            </button>
          );
        })}
      </div>
    </div>
  );
}
