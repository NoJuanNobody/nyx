import { SignIn as ClerkSignIn } from '@clerk/clerk-react';

export function SignIn() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <ClerkSignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        afterSignInUrl="/"
      />
    </div>
  );
}
