import { useQuery } from '@tanstack/react-query';
import { fetchTimeline, type TimelineEvent } from '../lib/api';

interface TimelineProps {
  documentId: string;
}

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  document_updated: { icon: '\u270F\uFE0F', color: 'bg-blue-100 text-blue-700', label: 'Document updated' },
  version_created: { icon: '\uD83D\uDCCC', color: 'bg-purple-100 text-purple-700', label: 'Version created' },
  ticket_created: { icon: '\uD83C\uDFAB', color: 'bg-amber-100 text-amber-700', label: 'Ticket created' },
  code_push: { icon: '\uD83D\uDE80', color: 'bg-green-100 text-green-700', label: 'Code pushed' },
  drift_detected: { icon: '\u26A0\uFE0F', color: 'bg-red-100 text-red-700', label: 'Drift detected' },
  branch_created: { icon: '\uD83C\uDF3F', color: 'bg-teal-100 text-teal-700', label: 'Branch created' },
  branch_merged: { icon: '\uD83D\uDD00', color: 'bg-indigo-100 text-indigo-700', label: 'Branch merged' },
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

function EventItem({ event }: { event: TimelineEvent }) {
  const config = EVENT_CONFIG[event.type] ?? {
    icon: '\uD83D\uDD35',
    color: 'bg-slate-100 text-slate-700',
    label: event.type,
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
    <div className="flex gap-3 px-4 py-3 border-b border-slate-100">
      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm ${config.color}`}>
        {config.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-900">{config.label}</span>
          <span className="text-xs text-slate-400 flex-shrink-0">{relativeTime(event.createdAt)}</span>
        </div>
        {detail && (
          <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>
        )}
      </div>
    </div>
  );
}

export function Timeline({ documentId }: TimelineProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['timeline', documentId],
    queryFn: () => fetchTimeline(documentId),
  });

  const events = data?.events ?? [];

  return (
    <div className="flex h-full flex-col bg-white">
      {isLoading && (
        <p className="p-4 text-sm text-slate-400">Loading timeline...</p>
      )}
      {!isLoading && events.length === 0 && (
        <p className="p-4 text-sm text-slate-400">No events yet.</p>
      )}
      <div className="flex-1 overflow-y-auto">
        {events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}
