import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAuditTrail, fetchAuditTrace, type AuditEvent } from '../lib/api';

interface AuditTrailProps {
  documentId: string;
}

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  doc_edit: { icon: '\u270F\uFE0F', color: 'bg-blue-100 text-blue-700', label: 'Document edited' },
  snapshot_created: { icon: '\uD83D\uDCF8', color: 'bg-purple-100 text-purple-700', label: 'Snapshot created' },
  ticket_created: { icon: '\uD83C\uDFAB', color: 'bg-amber-100 text-amber-700', label: 'Ticket created' },
  ticket_updated: { icon: '\uD83D\uDD04', color: 'bg-amber-50 text-amber-600', label: 'Ticket updated' },
  code_commit: { icon: '\uD83D\uDCBB', color: 'bg-green-100 text-green-700', label: 'Code commit' },
  proposal_created: { icon: '\uD83D\uDCDD', color: 'bg-indigo-100 text-indigo-700', label: 'Proposal created' },
  proposal_approved: { icon: '\u2705', color: 'bg-emerald-100 text-emerald-700', label: 'Proposal approved' },
  proposal_pushed: { icon: '\uD83D\uDE80', color: 'bg-cyan-100 text-cyan-700', label: 'Proposal pushed' },
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

function getEventDetail(event: AuditEvent): string {
  const m = event.metadata;
  switch (event.eventType) {
    case 'doc_edit':
      return m.fields ? `Fields: ${(m.fields as string[]).join(', ')}` : '';
    case 'ticket_created':
      return m.title ? String(m.title) : '';
    case 'code_commit':
      return m.message ? `${(event.commitSha ?? '').slice(0, 7)} — ${m.message}` : event.commitSha?.slice(0, 7) ?? '';
    case 'proposal_created':
    case 'proposal_approved':
    case 'proposal_pushed':
      return m.title ? String(m.title) : '';
    case 'snapshot_created':
      return m.name ? String(m.name) : '';
    default:
      return '';
  }
}

function TraceChain({ eventId }: { eventId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-trace', eventId],
    queryFn: () => fetchAuditTrace(eventId),
  });

  if (isLoading) return <p className="text-[10px] text-slate-400 px-2 py-1">Loading trace...</p>;
  const chain = data?.chain ?? [];
  if (chain.length <= 1) return <p className="text-[10px] text-slate-400 px-2 py-1">No linked events.</p>;

  return (
    <div className="ml-4 border-l-2 border-slate-200 pl-3 py-1 space-y-1">
      {chain.map((e, i) => {
        const cfg = EVENT_CONFIG[e.eventType] ?? { icon: '\uD83D\uDD35', color: 'bg-slate-100 text-slate-700', label: e.eventType };
        return (
          <div key={e.id} className="flex items-center gap-2">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${cfg.color}`}>
              {cfg.icon}
            </span>
            <span className="text-[10px] text-slate-600">{cfg.label}</span>
            {i === 0 && <span className="text-[10px] text-slate-400">(current)</span>}
          </div>
        );
      })}
    </div>
  );
}

function AuditEventItem({ event }: { event: AuditEvent }) {
  const [showTrace, setShowTrace] = useState(false);
  const config = EVENT_CONFIG[event.eventType] ?? {
    icon: '\uD83D\uDD35',
    color: 'bg-slate-100 text-slate-700',
    label: event.eventType,
  };
  const detail = getEventDetail(event);

  return (
    <div className="border-b border-slate-100">
      <div className="flex gap-3 px-4 py-3">
        <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm ${config.color}`}>
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-900">{config.label}</span>
            <span className="text-xs text-slate-400 flex-shrink-0">{relativeTime(event.createdAt)}</span>
          </div>
          {event.actorName && (
            <p className="text-[11px] text-slate-500">by {event.actorName}</p>
          )}
          {detail && (
            <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>
          )}
          {event.parentEventId && (
            <button
              type="button"
              onClick={() => setShowTrace(!showTrace)}
              className="mt-1 text-[10px] text-blue-600 hover:text-blue-800"
            >
              {showTrace ? 'Hide trace' : 'Show trace chain'}
            </button>
          )}
        </div>
      </div>
      {showTrace && event.parentEventId && <TraceChain eventId={event.id} />}
    </div>
  );
}

export function AuditTrail({ documentId }: AuditTrailProps) {
  const [filter, setFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['audit-trail', documentId],
    queryFn: () => fetchAuditTrail(documentId),
  });

  const events = data?.events ?? [];
  const filtered = filter === 'all' ? events : events.filter((e) => e.eventType === filter);

  const eventTypes = [...new Set(events.map((e) => e.eventType))];

  return (
    <div className="flex h-full flex-col bg-white">
      {eventTypes.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 px-4 py-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              filter === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All
          </button>
          {eventTypes.map((type) => {
            const cfg = EVENT_CONFIG[type];
            return (
              <button
                key={type}
                type="button"
                onClick={() => setFilter(type)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  filter === type ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cfg?.label ?? type}
              </button>
            );
          })}
        </div>
      )}

      {isLoading && (
        <p className="p-4 text-sm text-slate-400">Loading audit trail...</p>
      )}

      {!isLoading && filtered.length === 0 && (
        <p className="p-4 text-sm text-slate-400">No audit events yet.</p>
      )}

      <div className="flex-1 overflow-y-auto">
        {filtered.map((event) => (
          <AuditEventItem key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}
