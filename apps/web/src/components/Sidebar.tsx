import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '../stores/ui.store';
import { useAuthStore } from '../stores/auth.store';
import { FileTree } from './FileTree';
import { FeedbackModal } from './FeedbackModal';
import { getCreditsBalance } from '../lib/api';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function ThemeToggle() {
  const { theme, setTheme } = useUIStore();

  const cycle = () => {
    const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
  };

  const label = theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light';

  return (
    <button
      type="button"
      onClick={cycle}
      className="flex items-center gap-1.5 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
      title={`Theme: ${label}. Click to cycle.`}
    >
      {theme === 'dark' ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
        </svg>
      ) : theme === 'light' ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25Z" />
        </svg>
      )}
    </button>
  );
}

function UserSection({ collapsed }: { collapsed: boolean }) {
  const { user, teams, currentTeamId, setCurrentTeamId, clear } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    if (CLERK_ENABLED) {
      const { useClerk } = await import('@clerk/clerk-react');
      // Access clerk instance from window since we can't use hooks outside render
      try {
        const clerkInstance = (window as unknown as { Clerk?: { signOut: () => Promise<void> } }).Clerk;
        await clerkInstance?.signOut();
      } catch {
        // Clerk signout failed, continue with local cleanup
      }
    }
    clear();
    navigate(CLERK_ENABLED ? '/sign-in' : '/');
  };

  if (!user) return null;

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (collapsed) {
    return (
      <div className="border-t border-slate-200 px-2 py-3 flex flex-col items-center gap-2">
        {user.imageUrl ? (
          <img src={user.imageUrl} alt="" className="h-7 w-7 rounded-full" title={user.name} />
        ) : (
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-[10px] font-bold text-white"
            title={user.name}
          >
            {initials}
          </div>
        )}
        <button
          type="button"
          onClick={handleLogout}
          title="Sign out"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 px-3 py-3 space-y-2">
      {/* Team switcher */}
      {teams.length > 1 && (
        <select
          data-testid="team-switcher"
          value={currentTeamId ?? ''}
          onChange={(e) => setCurrentTeamId(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      )}

      {/* User info */}
      <div className="flex items-center gap-2">
        {user.imageUrl ? (
          <img src={user.imageUrl} alt="" className="h-7 w-7 rounded-full" />
        ) : (
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-[10px] font-bold text-white">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p data-testid="user-name" className="truncate text-xs font-medium text-slate-700">{user.name}</p>
          <p className="truncate text-[10px] text-slate-400">{user.role}</p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          title="Sign out"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function CreditBalance({ collapsed }: { collapsed: boolean }) {
  const { data } = useQuery({
    queryKey: ['credits-balance'],
    queryFn: getCreditsBalance,
    refetchInterval: 60_000,
  });

  if (data == null) return null;

  if (collapsed) {
    return (
      <div className="border-t border-slate-200 px-2 py-2 flex justify-center" title={`${data.balance} credits`}>
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <svg className="h-3.5 w-3.5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.798 7.45c.512-.67 1.135-.95 1.702-.95s1.19.28 1.702.95a.75.75 0 0 0 1.192-.91C12.637 5.55 11.5 5 10.5 5s-2.137.55-2.894 1.54a.75.75 0 0 0 1.192.91ZM10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" />
          </svg>
          {data.balance}
        </span>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 px-4 py-2 flex items-center gap-2">
      <svg className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.798 7.45c.512-.67 1.135-.95 1.702-.95s1.19.28 1.702.95a.75.75 0 0 0 1.192-.91C12.637 5.55 11.5 5 10.5 5s-2.137.55-2.894 1.54a.75.75 0 0 0 1.192.91ZM10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" />
      </svg>
      <span className="text-xs text-slate-500">{data.balance} credits</span>
    </div>
  );
}

const primaryNavItems = [
  {
    to: '/intake',
    label: 'Intake',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
      </svg>
    ),
  },
  {
    to: '/sprint',
    label: 'Sprint',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
  },
  {
    to: '/board',
    label: 'Board',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
      </svg>
    ),
  },
  {
    to: '/marketplace',
    label: 'Marketplace',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z" />
      </svg>
    ),
  },
  {
    to: '/repositories',
    label: 'Repos',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
  },
  {
    to: '/operations',
    label: 'Operations',
    icon: (
      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.049.58.025 1.193-.14 1.743ZM15 2.25a.75.75 0 0 1 .75.75v5.25a.75.75 0 0 1-1.5 0V3a.75.75 0 0 1 .75-.75Z" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const { sidebarOpen, setSidebarOpen, sidebarCollapsed, toggleSidebarCollapsed } =
    useUIStore();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const navLinkClass = (isActive: boolean, collapsed: boolean) =>
    `flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors ${collapsed ? 'justify-center px-2' : ''} ${
      isActive
        ? 'bg-blue-50 text-blue-700'
        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
    }`;

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-slate-200 bg-white transition-all duration-200 md:static md:translate-x-0 ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        } ${sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}`}
      >
        {/* Logo + collapse toggle */}
        <div className="flex h-14 items-center border-b border-slate-200">
          <NavLink
            to="/dashboard"
            onClick={() => setSidebarOpen(false)}
            className={`flex flex-1 items-center gap-2 h-full hover:bg-slate-50 transition-colors ${sidebarCollapsed ? 'justify-center px-2' : 'px-5'}`}
          >
            <svg
              className="h-6 w-6 shrink-0 text-blue-600"
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
            {!sidebarCollapsed && <span className="text-base font-semibold text-slate-900">Nyx</span>}
          </NavLink>
          {/* Collapse toggle — desktop only */}
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden lg:flex h-full items-center px-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
          >
            <svg
              className={`h-4 w-4 transition-transform duration-200 ${sidebarCollapsed ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
        </div>

        {/* File tree — full height (hidden when collapsed) */}
        {!sidebarCollapsed && (
          <div className="flex-1 overflow-hidden">
            <FileTree />
          </div>
        )}
        {sidebarCollapsed && <div className="flex-1" />}

        {/* Credit balance */}
        <CreditBalance collapsed={sidebarCollapsed} />

        {/* User section */}
        <UserSection collapsed={sidebarCollapsed} />

        {/* Primary nav */}
        <div className="border-t border-slate-200">
          {primaryNavItems.map((item) => {
            const displayLabel = item.label;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setSidebarOpen(false)}
                title={sidebarCollapsed ? displayLabel : undefined}
                className={({ isActive }) => navLinkClass(isActive, sidebarCollapsed)}
              >
                {item.icon}
                {!sidebarCollapsed && displayLabel}
              </NavLink>
            );
          })}
        </div>

        {/* Utility nav — Getting Started + Settings + Feedback */}
        <div className="border-t border-slate-200 pt-1 pb-1">
          <NavLink
            to="/getting-started"
            onClick={() => setSidebarOpen(false)}
            title={sidebarCollapsed ? 'Getting Started' : undefined}
            data-testid="getting-started-link"
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors ${sidebarCollapsed ? 'justify-center px-2' : ''} ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`
            }
          >
            <svg
              className="h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5"
              />
            </svg>
            {!sidebarCollapsed && 'Getting Started'}
          </NavLink>
          <div className={`flex items-center ${sidebarCollapsed ? 'flex-col gap-1 py-1' : ''}`}>
            <NavLink
              to="/settings"
              onClick={() => setSidebarOpen(false)}
              title={sidebarCollapsed ? 'Settings' : undefined}
              className={({ isActive }) =>
                `flex flex-1 items-center gap-3 px-4 py-2 text-sm font-medium transition-colors ${sidebarCollapsed ? 'justify-center px-2 flex-none w-full' : ''} ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                }`
              }
            >
              <svg
                className="h-4 w-4 shrink-0"
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
              {!sidebarCollapsed && 'Settings'}
            </NavLink>
            {!sidebarCollapsed && (
              <div className="pr-3">
                <ThemeToggle />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            title={sidebarCollapsed ? 'Send Feedback' : undefined}
            className={`flex w-full items-center gap-3 px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors ${sidebarCollapsed ? 'justify-center px-2' : ''}`}
            data-testid="feedback-button"
          >
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
            </svg>
            {!sidebarCollapsed && 'Send Feedback'}
          </button>
        </div>
      </aside>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
