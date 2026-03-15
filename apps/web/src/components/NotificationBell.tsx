import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchUnreadCount } from '../lib/api';
import { NotificationPanel } from './NotificationPanel';

export function NotificationBell() {
  const [panelOpen, setPanelOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
  });

  const count = data?.count ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="notification-bell"
        onClick={() => setPanelOpen((prev) => !prev)}
        className="relative rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
        title="Notifications"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {count > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {panelOpen && <NotificationPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
