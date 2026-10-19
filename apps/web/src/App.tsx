import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useParams,
} from 'react-router-dom';
import { HashbrownProvider } from '@hashbrownai/react';
import { Layout } from './components/Layout';
import { AuthGuard } from './components/AuthGuard';
import { Dashboard } from './pages/Dashboard';
import { DocumentEditor } from './pages/DocumentEditor';
import { Settings } from './pages/Settings';
import { Landing } from './pages/Landing';
import { Tickets } from './pages/Tickets';
import { Repositories } from './pages/Repositories';
import { IntakePage } from './pages/IntakePage';
import { SprintPage } from './pages/SprintPage';
import { TracePage } from './pages/TracePage';
import { OperationsPage } from './pages/OperationsPage';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { AcceptInvite } from './pages/AcceptInvite';
import { Pricing } from './pages/Pricing';
import { useAuthStore } from './stores/auth.store';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * Redirect component that preserves the current query string when navigating
 * to a new path. Used for backward-compat redirects from legacy top-level
 * routes (e.g. `/dashboard`) to their `/app/*` equivalents.
 */
function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

/**
 * Redirect for parameterized document routes. Reads `:id` from the URL and
 * forwards to `/app/documents/:id` (or `/app/documents/:id/trace`) with
 * query params preserved.
 */
function LegacyDocumentRedirect({ suffix = '' }: { suffix?: string }) {
  const { id } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/app/documents/${id}${suffix}${search}`} replace />;
}

/**
 * Root path (`/`) handler:
 * - Anonymous users see the `Landing` page.
 * - Authenticated users are redirected to `/app/dashboard`.
 * - In dev mode (no Clerk), `/` redirects to `/app/dashboard` for convenience.
 */
function RootRoute() {
  const user = useAuthStore((s) => s.user);
  if (!CLERK_ENABLED) return <Navigate to="/app/dashboard" replace />;
  if (user) return <Navigate to="/app/dashboard" replace />;
  return <Landing />;
}

const GENERATIVE_ENDPOINT = `${import.meta.env.VITE_API_URL ?? ''}/api/generative/run`;

export function App() {
  return (
    <HashbrownProvider url={GENERATIVE_ENDPOINT}>
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<RootRoute />} />
        <Route path="/sign-in/*" element={<SignIn />} />
        <Route path="/sign-up/*" element={<SignUp />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/pricing" element={<Pricing />} />
        {/* `/landing` is retired — `/` is now the landing page */}
        <Route path="/landing" element={<Navigate to="/" replace />} />

        {/* Authenticated app — mounted under /app/* */}
        <Route path="/app" element={<AuthGuard />}>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/app/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="documents/:id" element={<DocumentEditor />} />
            <Route path="documents/:id/trace" element={<TracePage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="board" element={<Navigate to="/app/tickets" replace />} />
            <Route path="repositories" element={<Repositories />} />
            <Route path="intake" element={<IntakePage />} />
            <Route path="sprint" element={<SprintPage />} />
            <Route path="operations" element={<OperationsPage />} />
            <Route path="getting-started" element={<Navigate to="/app/dashboard" replace />} />
            {/* In-app redirects (previously top-level) repointed under /app */}
            <Route
              path="agent-map"
              element={<Navigate to="/app/operations?tab=agents" replace />}
            />
            <Route
              path="observability"
              element={<Navigate to="/app/operations?tab=observability" replace />}
            />
            <Route
              path="voice"
              element={<Navigate to="/app/operations?tab=voice" replace />}
            />
            <Route
              path="admin/documents"
              element={<Navigate to="/app/dashboard" replace />}
            />
          </Route>
        </Route>

        {/* Backward-compat redirects from legacy top-level paths. These
            preserve query strings (and :id params) so existing bookmarks,
            external links, and emails keep working. */}
        <Route path="/dashboard" element={<LegacyRedirect to="/app/dashboard" />} />
        <Route path="/documents/:id" element={<LegacyDocumentRedirect />} />
        <Route
          path="/documents/:id/trace"
          element={<LegacyDocumentRedirect suffix="/trace" />}
        />
        <Route path="/settings" element={<LegacyRedirect to="/app/settings" />} />
        <Route path="/board" element={<LegacyRedirect to="/app/tickets" />} />
        <Route
          path="/repositories"
          element={<LegacyRedirect to="/app/repositories" />}
        />
        <Route path="/intake" element={<LegacyRedirect to="/app/intake" />} />
        <Route path="/sprint" element={<LegacyRedirect to="/app/sprint" />} />
        <Route
          path="/operations"
          element={<LegacyRedirect to="/app/operations" />}
        />
        <Route
          path="/getting-started"
          element={<LegacyRedirect to="/app/getting-started" />}
        />
        {/* Legacy tab-redirect helpers at the root also forward under /app */}
        <Route
          path="/agent-map"
          element={<Navigate to="/app/operations?tab=agents" replace />}
        />
        <Route
          path="/observability"
          element={<Navigate to="/app/operations?tab=observability" replace />}
        />
        <Route
          path="/voice"
          element={<Navigate to="/app/operations?tab=voice" replace />}
        />
        <Route
          path="/admin/documents"
          element={<Navigate to="/app/dashboard" replace />}
        />
      </Routes>
    </BrowserRouter>
    </HashbrownProvider>
  );
}
