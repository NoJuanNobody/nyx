import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient();
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!clerkKey) {
  document.getElementById('root')!.innerHTML =
    '<div style="padding:2rem;font-family:system-ui"><h1>Configuration Error</h1><p>VITE_CLERK_PUBLISHABLE_KEY is not set. Check your environment variables.</p></div>';
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/sign-in">
      {children}
    </ClerkProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </Providers>
  </StrictMode>,
);
