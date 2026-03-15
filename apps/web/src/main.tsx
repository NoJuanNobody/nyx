import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient();
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined
  || 'pk_test_d2VsY29tZS1qYXZlbGluLTg5LmNsZXJrLmFjY291bnRzLmRldiQ';

function Providers({ children }: { children: React.ReactNode }) {
  if (clerkKey) {
    return (
      <ClerkProvider publishableKey={clerkKey}>
        {children}
      </ClerkProvider>
    );
  }
  return <>{children}</>;
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
