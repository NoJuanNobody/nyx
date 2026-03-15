import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationBell } from './NotificationBell';
import { useUIStore } from '../stores/ui.store';

export function Layout() {
  const { toggleSidebar } = useUIStore();

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 py-2">
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:hidden"
            aria-label="Toggle sidebar"
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
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
          </button>
          <span className="text-sm font-semibold text-slate-900 lg:hidden">Nyx</span>
          <div className="flex-1" />
          <NotificationBell />
        </div>

        {/* Main content */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
