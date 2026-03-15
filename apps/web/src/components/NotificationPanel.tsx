import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../lib/api';

type FilterTab = 'all' | 'unread' | 'drift' | 'tickets';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface NotificationPanelProps {
  onClose: () => void;
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const queryParams = (() => {
    switch (activeFilter) {
      case 'unread':
        return { read: false, limit: 50 };
      case 'drift':
        return { eventType: 'drift', limit: 50 };
      case 'tickets':
        return { eventType: 'ticket', limit: 50 };
      default:
        return { limit: 50 };
    }
  })();

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', queryParams],
    queryFn: () => fetchNotifications(queryParams),
  });

  const markReadMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const handleItemClick = (item: any) => {
    if (!item.read) {
      markReadMutation.mutate(item.id);
    }
    // Navigate based on metadata
    if (item.metadata?.documentId) {
      navigate(`/documents/${item.metadata.documentId}`);
      onClose();
    } else if (item.metadata?.ticketId) {
      navigate('/board');
      onClose();
    }
  };

  const filters: { key: FilterTab; label: string; testId: string }[] = [
    { key: 'all', label: 'All', testId: 'filter-all' },
    { key: 'unread', label: 'Unread', testId: 'filter-unread' },
    { key: 'drift', label: 'Drift', testId: 'filter-drift' },
    { key: 'tickets', label: 'Tickets', testId: 'filter-tickets' },
  ];

  const items = data?.items ?? [];

  return (
    <div
      data-testid="notification-panel"
      className="absolute right-0 top-full mt-2 z-50 w-96 max-h-[32rem] flex flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Notifications</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="mark-all-read"
            onClick={() => markAllReadMutation.mutate()}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Mark all as read
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-slate-200 px-4 py-2">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid={f.testId}
            onClick={() => setActiveFilter(f.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              activeFilter === f.key
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-slate-400">Loading...</span>
          </div>
        )}
        {!isLoading && items.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-slate-400">No notifications</span>
          </div>
        )}
        {items.map((item: any) => (
          <button
            key={item.id}
            type="button"
            data-testid="notification-item"
            onClick={() => handleItemClick(item)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0"
          >
            {/* Unread indicator */}
            <div
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                !item.read ? 'bg-blue-500' : 'bg-transparent'
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className={`text-sm truncate ${!item.read ? 'font-semibold text-slate-900' : 'font-medium text-slate-600'}`}>
                {item.title}
              </p>
              {item.body && (
                <p className="mt-0.5 text-xs text-slate-400 truncate">{item.body}</p>
              )}
              <p className="mt-1 text-[10px] text-slate-400">
                {relativeTime(item.createdAt)}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
