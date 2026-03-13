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
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
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
        <Route path="/landing" element={<Landing />} />
        <Route element={<AuthGuard />}>
          <Route element={<Layout />}>
            <Route path="/" element={<LandingOrDashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/documents/:id" element={<DocumentEditor />} />
            <Route path="/documents/:id/preview" element={<JSXPreviewPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/board" element={<Board />} />
            <Route path="/repositories" element={<Repositories />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
