import { Navigate, useSearchParams } from 'react-router-dom';
import { SignUp as ClerkSignUp } from '@clerk/clerk-react';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function SignUp() {
  const [searchParams] = useSearchParams();
  if (!CLERK_ENABLED) {
    return <Navigate to="/" replace />;
  }

  const redirectUrl = searchParams.get('redirect_url') || '/app/dashboard';
  const signInParams = new URLSearchParams();
  if (searchParams.get('redirect_url')) signInParams.set('redirect_url', redirectUrl);
  if (searchParams.get('__clerk_ticket')) signInParams.set('__clerk_ticket', searchParams.get('__clerk_ticket')!);
  const signInUrl = signInParams.toString() ? `/sign-in?${signInParams.toString()}` : '/sign-in';

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <ClerkSignUp
        routing="path"
        path="/sign-up"
        signInUrl={signInUrl}
        fallbackRedirectUrl={redirectUrl}
        forceRedirectUrl={redirectUrl}
      />
    </div>
  );
}
