import { useState } from 'react';
import { NavLink, useParams, useMatch } from 'react-router-dom';
import { useUIStore } from '../stores/ui.store';
import { FileTree } from './FileTree';
import { VersionHistory } from './VersionHistory';
import { Timeline } from './Timeline';

export function Sidebar() {
  const { sidebarOpen, setSidebarOpen } = useUIStore();
  const docMatch = useMatch('/documents/:id');
  const documentId = docMatch?.params.id ?? null;
  const [sidebarDocTab, setSidebarDocTab] = useState<'history' | 'timeline'>('history');

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo — links to dashboard */}
        <NavLink
          to="/"
          onClick={() => setSidebarOpen(false)}
          className="flex h-14 items-center gap-2 border-b border-slate-200 px-5 hover:bg-slate-50 transition-colors"
        >
          <svg
            className="h-6 w-6 text-blue-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
            />
          </svg>
          <span className="text-base font-semibold text-slate-900">SyncDocs</span>
        </NavLink>

        {/* File tree — main content area */}
        <div className="flex-1 overflow-hidden">
          <FileTree />
        </div>

        {/* Document History / Timeline — shown when a doc is open */}
        {documentId && (
          <div className="flex flex-col border-t border-slate-200" style={{ maxHeight: '40%' }}>
            <div className="flex flex-shrink-0 border-b border-slate-100">
              <button
                type="button"
                onClick={() => setSidebarDocTab('history')}
                className={`flex-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  sidebarDocTab === 'history'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                History
              </button>
              <button
                type="button"
                onClick={() => setSidebarDocTab('timeline')}
                className={`flex-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  sidebarDocTab === 'timeline'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                Timeline
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sidebarDocTab === 'history' ? (
                <VersionHistory documentId={documentId} />
              ) : (
                <Timeline documentId={documentId} />
              )}
            </div>
          </div>
        )}

        {/* Bottom: Settings */}
        <div className="border-t border-slate-200">
          <NavLink
            to="/settings"
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`
            }
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              />
            </svg>
            Settings
          </NavLink>
        </div>
      </aside>
    </>
  );
}
