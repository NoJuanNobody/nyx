import { Navigate, useSearchParams } from 'react-router-dom';
import { SignIn as ClerkSignIn } from '@clerk/clerk-react';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function SignIn() {
  const [searchParams] = useSearchParams();
  if (!CLERK_ENABLED) {
    return <Navigate to="/" replace />;
  }

  const redirectUrl = searchParams.get('redirect_url') || '/app/dashboard';

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <ClerkSignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl={redirectUrl}
        forceRedirectUrl={redirectUrl}
      />
    </div>
  );
}
