import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useUIStore } from '../stores/ui.store';

export function Layout() {
  const { toggleSidebar } = useUIStore();

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-6">
          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:hidden"
            aria-label="Toggle sidebar"
          >
            <svg
              className="h-6 w-6"
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

          {/* App name (visible on mobile when sidebar is hidden) */}
          <span className="text-lg font-semibold text-slate-900 lg:hidden">
            SyncDocs
          </span>

          {/* Spacer for desktop */}
          <div className="hidden lg:block" />

          {/* User avatar */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white hover:bg-blue-700"
              aria-label="User menu"
            >
              U
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
