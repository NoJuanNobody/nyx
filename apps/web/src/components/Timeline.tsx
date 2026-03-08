import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTimeline, type TimelineEvent } from '../lib/api';

interface TimelineProps {
  documentId: string;
  onSwitchToHistory?: (versionId: string) => void;
}

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string; chipLabel: string }> = {
  document_updated: { icon: '\u270F\uFE0F', color: 'bg-blue-100 text-blue-700', label: 'Document updated', chipLabel: 'Updated' },
  version_created: { icon: '\uD83D\uDCCC', color: 'bg-purple-100 text-purple-700', label: 'Version created', chipLabel: 'Version' },
  ticket_created: { icon: '\uD83C\uDFAB', color: 'bg-amber-100 text-amber-700', label: 'Ticket created', chipLabel: 'Ticket' },
  code_push: { icon: '\uD83D\uDE80', color: 'bg-green-100 text-green-700', label: 'Code pushed', chipLabel: 'Push' },
  drift_detected: { icon: '\u26A0\uFE0F', color: 'bg-red-100 text-red-700', label: 'Drift detected', chipLabel: 'Drift' },
  branch_created: { icon: '\uD83C\uDF3F', color: 'bg-teal-100 text-teal-700', label: 'Branch created', chipLabel: 'Branch' },
  branch_merged: { icon: '\uD83D\uDD00', color: 'bg-indigo-100 text-indigo-700', label: 'Branch merged', chipLabel: 'Merged' },
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function EventDetails({
  event,
  onSwitchToHistory,
}: {
  event: TimelineEvent;
  onSwitchToHistory?: (versionId: string) => void;
}) {
  const p = event.payload;

  switch (event.type) {
    case 'document_updated': {
      const fields = (p.changedFields as string[] | undefined) ?? [];
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5">
          {fields.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {fields.map((f) => (
                <span key={f} className="inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                  {f}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">Document content was updated.</p>
          )}
        </div>
      );
    }
    case 'version_created':
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5 space-y-1">
          {p.versionNumber && (
            <p className="text-xs text-slate-600">
              <span className="font-medium">Version:</span> {String(p.versionNumber)}
            </p>
          )}
          {p.message && (
            <p className="text-xs text-slate-600">{String(p.message)}</p>
          )}
          {p.hash && (
            <p className="text-[10px] font-mono text-slate-400">{String(p.hash)}</p>
          )}
          {onSwitchToHistory && p.versionId && (
            <button
              type="button"
              onClick={() => onSwitchToHistory(String(p.versionId))}
              className="mt-1 text-[11px] font-medium text-purple-600 hover:text-purple-800 hover:underline"
            >
              View in History &rarr;
            </button>
          )}
        </div>
      );
    case 'ticket_created':
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5 space-y-1">
          {p.title && (
            <p className="text-xs font-medium text-slate-700">{String(p.title)}</p>
          )}
          {p.provider && (
            <span className="inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              {String(p.provider)}
            </span>
          )}
          {p.externalUrl && (
            <a
              href={String(p.externalUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-[11px] font-medium text-amber-600 hover:text-amber-800 hover:underline"
            >
              Open Ticket &rarr;
            </a>
          )}
        </div>
      );
    case 'code_push':
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5 space-y-1">
          {p.ref && (
            <span className="inline-block rounded bg-green-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-green-700">
              {String(p.ref)}
            </span>
          )}
          {p.commits && (
            <p className="text-xs text-slate-600">{String(p.commits)} commit(s)</p>
          )}
          {Array.isArray(p.changedFiles) && p.changedFiles.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {(p.changedFiles as string[]).slice(0, 8).map((f) => (
                <li key={f} className="truncate font-mono text-[10px] text-slate-500">{f}</li>
              ))}
              {(p.changedFiles as string[]).length > 8 && (
                <li className="text-[10px] text-slate-400">+{(p.changedFiles as string[]).length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      );
    case 'drift_detected':
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5 space-y-1">
          {p.score != null && (
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                Number(p.score) >= 0.7
                  ? 'bg-red-100 text-red-700'
                  : Number(p.score) >= 0.4
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-yellow-100 text-yellow-700'
              }`}
            >
              Drift score: {String(p.score)}
            </span>
          )}
          {p.details && (
            <p className="text-xs text-slate-600">{String(p.details)}</p>
          )}
        </div>
      );
    case 'proposal_pushed':
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5 space-y-1">
          {p.title && (
            <p className="text-xs font-medium text-slate-700">{String(p.title)}</p>
          )}
          {p.ticketCount != null && (
            <p className="text-xs text-slate-500">{String(p.ticketCount)} ticket(s)</p>
          )}
        </div>
      );
    default:
      return (
        <div className="bg-slate-50 rounded-md p-2 mt-1.5">
          <pre className="text-[10px] text-slate-500 whitespace-pre-wrap">
            {JSON.stringify(p, null, 2)}
          </pre>
        </div>
      );
  }
}

function EventItem({
  event,
  isExpanded,
  onToggle,
  onSwitchToHistory,
}: {
  event: TimelineEvent;
  isExpanded: boolean;
  onToggle: () => void;
  onSwitchToHistory?: (versionId: string) => void;
}) {
  const config = EVENT_CONFIG[event.type] ?? {
    icon: '\uD83D\uDD35',
    color: 'bg-slate-100 text-slate-700',
    label: event.type,
    chipLabel: event.type,
  };

  const payload = event.payload;
  let detail = '';
  if (event.type === 'version_created' && payload.message) {
    detail = String(payload.message);
  } else if (event.type === 'ticket_created' && payload.title) {
    detail = String(payload.title);
  } else if (event.type === 'drift_detected' && payload.details) {
    detail = String(payload.details);
  } else if (event.type === 'code_push' && payload.commits) {
    detail = `${payload.commits} commit(s)`;
  }

  return (
    <div
      className="border-b border-slate-100 transition-colors hover:bg-slate-50/50 cursor-pointer"
      onClick={onToggle}
    >
      <div className="flex gap-3 px-4 py-3">
        <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm ${config.color}`}>
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-900">{config.label}</span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-xs text-slate-400">{relativeTime(event.createdAt)}</span>
              <svg
                className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
            </div>
          </div>
          {!isExpanded && detail && (
            <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>
          )}
          {isExpanded && (
            <EventDetails event={event} onSwitchToHistory={onSwitchToHistory} />
          )}
        </div>
      </div>
    </div>
  );
}

export function Timeline({ documentId, onSwitchToHistory }: TimelineProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<string> | null>(null); // null = all active

  const { data, isLoading } = useQuery({
    queryKey: ['timeline', documentId],
    queryFn: () => fetchTimeline(documentId),
  });

  const events = data?.events ?? [];

  // Collect unique event types present in the data
  const eventTypes = useMemo(() => {
    const types = new Set<string>();
    events.forEach((e) => types.add(e.type));
    return Array.from(types);
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (!activeFilters) return events;
    return events.filter((e) => activeFilters.has(e.type));
  }, [events, activeFilters]);

  const toggleFilter = (type: string) => {
    setActiveFilters((prev) => {
      if (!prev) {
        // Currently showing all — switch to showing only NOT this type
        const next = new Set(eventTypes);
        next.delete(type);
        return next.size === 0 ? null : next;
      }
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
        return next.size === 0 ? null : next; // if nothing left, show all
      } else {
        next.add(type);
        // If all types are now active, go back to null (all)
        return next.size === eventTypes.length ? null : next;
      }
    });
  };

  const allActive = activeFilters === null;

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Filter bar */}
      {eventTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-4 py-2">
          <button
            type="button"
            onClick={() => setActiveFilters(null)}
            className={`text-[10px] font-semibold uppercase tracking-wide transition-colors ${
              allActive ? 'text-slate-700' : 'text-slate-300 hover:text-slate-500'
            }`}
          >
            All
          </button>
          <span className="text-slate-200">|</span>
          {eventTypes.map((type) => {
            const cfg = EVENT_CONFIG[type];
            if (!cfg) return null;
            const isActive = allActive || activeFilters?.has(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleFilter(type)}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? cfg.color
                    : 'bg-slate-50 text-slate-300'
                }`}
              >
                <span className="text-xs leading-none">{cfg.icon}</span>
                {cfg.chipLabel}
              </button>
            );
          })}
        </div>
      )}

      {isLoading && (
        <p className="p-4 text-sm text-slate-400">Loading timeline...</p>
      )}
      {!isLoading && events.length === 0 && (
        <p className="p-4 text-sm text-slate-400">No events yet.</p>
      )}
      {!isLoading && events.length > 0 && filteredEvents.length === 0 && (
        <p className="p-4 text-sm text-slate-400">No events match the selected filters.</p>
      )}
      <div className="flex-1 overflow-y-auto">
        {filteredEvents.map((event) => (
          <EventItem
            key={event.id}
            event={event}
            isExpanded={expandedId === event.id}
            onToggle={() => setExpandedId((prev) => (prev === event.id ? null : event.id))}
            onSwitchToHistory={onSwitchToHistory}
          />
        ))}
      </div>
    </div>
  );
}
