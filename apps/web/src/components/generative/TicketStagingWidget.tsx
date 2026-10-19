/**
 * TicketStagingWidget — generative UI component for AI-streamed ticket staging.
 *
 * The model streams ticket proposals into this widget; stakeholders can edit
 * title, description, and priority before dispatching to GitHub/Jira via Nyx's
 * existing integrations.
 */
import { useState } from 'react';

export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketTarget = 'github' | 'jira';

export interface TicketStagingWidgetProps {
  /** Proposed ticket title */
  title?: string;
  /** Full ticket description (markdown) */
  description?: string;
  /** Suggested priority */
  priority?: TicketPriority;
  /** Labels / tags proposed by AI */
  labels?: string[];
  /** Target repo owner/name for GitHub */
  targetRepo?: string;
  /** Called when user approves and dispatches the ticket */
  onDispatch?: (ticket: { title: string; description: string; priority: TicketPriority; labels: string[] }) => void;
  /** Called when user dismisses this suggestion */
  onDismiss?: () => void;
}

const PRIORITY_STYLES: Record<TicketPriority, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  critical: 'bg-red-100 text-red-700',
};

export function TicketStagingWidget({
  title: initialTitle = '',
  description: initialDescription = '',
  priority: initialPriority = 'medium',
  labels: initialLabels = [],
  targetRepo,
  onDispatch,
  onDismiss,
}: TicketStagingWidgetProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [priority, setPriority] = useState<TicketPriority>(initialPriority);
  const [dispatched, setDispatched] = useState(false);

  // Sync streamed-in props until user starts editing
  // (Hashbrown updates props while streaming; we use initialXxx as defaults)

  if (dispatched) {
    return (
      <div
        className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700"
        data-testid="ticket-staging-dispatched"
      >
        ✓ Ticket queued for dispatch — <span className="font-medium">{title}</span>
      </div>
    );
  }

  function handleDispatch() {
    if (!title.trim()) return;
    setDispatched(true);
    onDispatch?.({ title, description, priority, labels: initialLabels });
  }

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white shadow-sm"
      data-testid="ticket-staging-widget"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="text-sm font-medium text-slate-800">AI Ticket Suggestion</span>
        {targetRepo && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {targetRepo}
          </span>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        {/* Title */}
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Ticket title…"
            data-testid="ticket-title-input"
          />
        </div>

        {/* Description */}
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Ticket description…"
            data-testid="ticket-description-input"
          />
        </div>

        {/* Priority + Labels */}
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TicketPriority)}
              className={`rounded-md border border-slate-200 px-2 py-1 text-xs font-medium focus:outline-none ${PRIORITY_STYLES[priority]}`}
              data-testid="ticket-priority-select"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {initialLabels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {initialLabels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
        <button
          onClick={onDismiss}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
          data-testid="ticket-dismiss-btn"
        >
          Dismiss
        </button>
        <button
          onClick={handleDispatch}
          disabled={!title.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="ticket-dispatch-btn"
        >
          Approve &amp; Dispatch
        </button>
      </div>
    </div>
  );
}
