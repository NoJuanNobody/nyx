import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthGuard } from './components/AuthGuard';
import { Dashboard } from './pages/Dashboard';
import { DocumentEditor } from './pages/DocumentEditor';
import { Settings } from './pages/Settings';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/sign-up" element={<SignUp />} />
        <Route element={<AuthGuard />}>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/documents/:id" element={<DocumentEditor />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
