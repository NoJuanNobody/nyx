import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthGuard } from './components/AuthGuard';
import { Dashboard } from './pages/Dashboard';
import { DocumentEditor } from './pages/DocumentEditor';
import { JSXPreviewPage } from './pages/JSXPreviewPage';
import { Settings } from './pages/Settings';
import { Landing } from './pages/Landing';
import { Board } from './pages/Board';
import { Repositories } from './pages/Repositories';
import { LifecycleExplorerPage } from './pages/LifecycleExplorerPage';
import { IntakePage } from './pages/IntakePage';
import { SprintPage } from './pages/SprintPage';
import { TracePage } from './pages/TracePage';
import { Marketplace } from './pages/Marketplace';
import { AgentMapPage } from './pages/AgentMapPage';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { AcceptInvite } from './pages/AcceptInvite';
import { useAuthStore } from './stores/auth.store';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function LandingOrDashboard() {
  const user = useAuthStore((s) => s.user);
  // In dev mode without Clerk, go straight to dashboard
  if (!CLERK_ENABLED) return <Dashboard />;
  // If authenticated, redirect to dashboard
  if (user) return <Navigate to="/dashboard" replace />;
  // Otherwise show landing page
  return <Landing />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sign-in/*" element={<SignIn />} />
        <Route path="/sign-up/*" element={<SignUp />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/landing" element={<Landing />} />
        <Route element={<AuthGuard />}>
          <Route element={<Layout />}>
            <Route path="/" element={<LandingOrDashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/documents/:id" element={<DocumentEditor />} />
            <Route path="/documents/:id/preview" element={<JSXPreviewPage />} />
            <Route path="/documents/:id/trace" element={<TracePage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/board" element={<Board />} />
            <Route path="/repositories" element={<Repositories />} />
            <Route path="/lifecycle" element={<LifecycleExplorerPage />} />
            <Route path="/intake" element={<IntakePage />} />
            <Route path="/sprint" element={<SprintPage />} />
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/agent-map" element={<AgentMapPage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
