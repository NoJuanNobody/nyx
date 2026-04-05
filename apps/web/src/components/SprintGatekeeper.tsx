import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/auth.store';
import {
  getSprintCapacity,
  checkSprintCapacity,
  deferSprintTicket,
<<<<<<< HEAD
  scheduleNextSprint,
=======
>>>>>>> feat/issue-125-community-marketplace
  type SprintTicket,
  type SprintCapacityData,
  type SprintCheckResult,
} from '../lib/api';

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-green-100 text-green-700';
    case 'in_progress':
      return 'bg-blue-100 text-blue-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function capacityBarColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 80) return 'bg-amber-500';
  return 'bg-blue-500';
}

export function SprintGatekeeper() {
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [capacity, setCapacity] = useState<SprintCapacityData | null>(null);
  const [checkResult, setCheckResult] = useState<SprintCheckResult | null>(null);
  const [selectedDefer, setSelectedDefer] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [deferring, setDeferring] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCapacity = useCallback(async () => {
    if (!currentTeamId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getSprintCapacity(currentTeamId);
      setCapacity(data);

      const check = await checkSprintCapacity({ teamId: currentTeamId });
      setCheckResult(check);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sprint data');
    } finally {
      setLoading(false);
    }
  }, [currentTeamId]);

  useEffect(() => {
    loadCapacity();
  }, [loadCapacity]);

  const toggleDefer = (ticketId: string) => {
    setSelectedDefer((prev) => {
      const next = new Set(prev);
      if (next.has(ticketId)) {
        next.delete(ticketId);
      } else {
        next.add(ticketId);
      }
      return next;
    });
  };

  const handleDeferAndAdd = async () => {
    if (!currentTeamId || selectedDefer.size === 0) return;
    setDeferring(true);
    try {
      for (const ticketKey of selectedDefer) {
        await deferSprintTicket({ teamId: currentTeamId, ticketKey });
      }
      setSelectedDefer(new Set());
      await loadCapacity();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to defer tickets');
    } finally {
      setDeferring(false);
    }
  };

  const handleScheduleNextSprint = async () => {
    if (!currentTeamId || selectedDefer.size === 0) return;
    setScheduling(true);
    try {
      await scheduleNextSprint({ teamId: currentTeamId, ticketKeys: Array.from(selectedDefer) });
      setSelectedDefer(new Set());
      await loadCapacity();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule tickets');
    } finally {
      setScheduling(false);
    }
  };

  if (!currentTeamId) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Select a team to view sprint capacity.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-48 rounded bg-slate-200" />
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded bg-slate-100" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <p className="text-sm text-red-700">{error}</p>
        <button
          type="button"
          onClick={loadCapacity}
          className="mt-2 text-sm font-medium text-red-600 underline hover:text-red-800"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!capacity) return null;

  // Empty state: no integration connected or no tickets
  if (capacity.source === 'none') {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center" data-testid="sprint-gatekeeper">
        <svg
          className="mx-auto h-12 w-12 text-slate-300"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"
          />
        </svg>
        <h3 className="mt-3 text-sm font-semibold text-slate-900">No sprint data available</h3>
        <p className="mt-1 text-sm text-slate-500">
          Connect a GitHub or Jira integration to view sprint capacity and manage trade-offs.
        </p>
      </div>
    );
  }

  const isOverThreshold = checkResult?.overThreshold ?? false;
  const deferrableTickets = capacity.tickets.filter((t) => t.status === 'todo');

  return (
    <div className="space-y-4" data-testid="sprint-gatekeeper">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">{capacity.sprintName}</h2>
            {capacity.source === 'github' && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">GitHub Projects</span>
            )}
            {capacity.source === 'jira' && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">Jira</span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {capacity.usedWeight} / {capacity.totalWeight} decision weight used
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            capacity.capacityPercent >= 90
              ? 'bg-red-100 text-red-700'
              : capacity.capacityPercent >= 80
                ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700'
          }`}
        >
          {capacity.capacityPercent}% capacity
        </span>
      </div>

      {/* Capacity bar */}
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all duration-300 ${capacityBarColor(capacity.capacityPercent)}`}
          style={{ width: `${Math.min(capacity.capacityPercent, 100)}%` }}
        />
      </div>

      {/* Warning banner when over threshold */}
      {isOverThreshold && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-4"
          data-testid="sprint-warning-banner"
        >
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">
                Sprint is at {capacity.capacityPercent}% judgment bandwidth.
              </p>
              <p className="mt-1 text-sm text-amber-700">
                Your team's review capacity is near saturation. Defer tickets to free decision bandwidth:
              </p>
            </div>
          </div>

          {/* Deferrable tickets */}
          {deferrableTickets.length > 0 ? (
            <div className="mt-3 space-y-2">
              {deferrableTickets.map((ticket) => (
                <label
                  key={ticket.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-amber-100 bg-white p-3 hover:border-amber-300 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedDefer.has(ticket.id)}
                    onChange={() => toggleDefer(ticket.id)}
                    className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-slate-800">{ticket.title}</span>
                    <span className="ml-2 text-xs text-slate-500">{ticket.id}</span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-xs font-medium text-slate-600">wt {ticket.decisionWeight}</span>
                    <span className="text-xs text-slate-400">{ticket.reviewCycles} review{ticket.reviewCycles !== 1 ? 's' : ''}</span>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber-600">
              All current tickets are in progress. The team's review bandwidth is saturated.
            </p>
          )}

          {/* Actions */}
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handleDeferAndAdd}
              disabled={selectedDefer.size === 0 || deferring}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              data-testid="defer-and-add-button"
            >
              {deferring ? 'Deferring...' : `Defer & Add (${selectedDefer.size} selected)`}
            </button>
            <button
              type="button"
              onClick={handleScheduleNextSprint}
              disabled={selectedDefer.size === 0 || scheduling}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              data-testid="schedule-next-sprint-button"
            >
              {scheduling ? 'Scheduling...' : `Schedule for Next Sprint (${selectedDefer.size})`}
            </button>
          </div>
        </div>
      )}

      {/* Active sprint tickets */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Sprint Tickets</h3>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {capacity.tickets.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-500">
              No tickets in this sprint.
            </div>
          ) : (
            capacity.tickets.map((ticket) => (
              <div key={ticket.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-slate-400">{ticket.id}</span>
                  <span className="truncate text-sm text-slate-800">{ticket.title}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-slate-500" title="Decision weight">wt {ticket.decisionWeight}</span>
                  <span className="text-xs text-slate-400" title="Review cycles">{ticket.reviewCycles}R</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(ticket.status)}`}
                  >
                    {ticket.status.replace('_', ' ')}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
