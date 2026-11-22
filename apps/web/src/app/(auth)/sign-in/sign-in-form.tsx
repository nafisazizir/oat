'use client';

import { Button } from '@oat/ui/components/button';
import {
  AuthPanel,
  AuthHeader,
  AuthTitle,
  AuthDescription,
  AuthContent,
  AuthDivider,
} from '@oat/ui/components/auth-layout';
import { Field, FieldLabel } from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import { Spinner } from '@oat/ui/components/spinner';
import { IconBrandGoogle } from '@tabler/icons-react';
import { useState } from 'react';

import { authClient, GOOGLE_PROVIDER_ID } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

type State =
  | { step: 'form'; pending: 'email' | 'google' | null; error: string | null }
  | { step: 'sent'; email: string };

/**
 * Magic link (email → "check your email") and Google (redirects to the provider; the mock issuer in
 * dev). Both come back through `/api/auth/*`, which sets the session cookie and redirects to `next`.
 */
export function SignInForm({
  next,
  initialError,
  mailpitUrl,
}: {
  /** Same-origin path to land on after sign-in (already sanitised by the page). */
  next: string;
  initialError: string | null;
  /** Dev only: where sent mail can be read (Mailpit). */
  mailpitUrl?: string;
}) {
  const [state, setState] = useState<State>({ step: 'form', pending: null, error: initialError });
  const pending = state.step === 'form' ? state.pending : null;
  // Until hydrated, a click would do nothing / submit the form natively (see useHydrated).
  const disabled = !useHydrated() || pending !== null;

  async function sendLink(email: string) {
    setState({ step: 'form', pending: 'email', error: null });
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: next,
      errorCallbackURL: '/sign-in',
    });
    if (error) {
      setState({
        step: 'form',
        pending: null,
        error:
          error.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : 'We couldn’t send the link. Check the address and try again.',
      });
      return;
    }
    setState({ step: 'sent', email });
  }

  async function continueWithGoogle() {
    setState({ step: 'form', pending: 'google', error: null });
    const { error } = await authClient.signIn.social({
      provider: GOOGLE_PROVIDER_ID,
      callbackURL: next,
      errorCallbackURL: '/sign-in',
    });
    // On success the browser is already navigating to the provider.
    if (error) {
      setState({
        step: 'form',
        pending: null,
        error: 'Google sign-in isn’t available right now. Try the email link instead.',
      });
    }
  }

  if (state.step === 'sent') {
    return (
      <AuthPanel data-testid="magic-link-sent">
        <AuthHeader>
          <AuthTitle>
            <h1>Check your email</h1>
          </AuthTitle>
          <AuthDescription role="status">
            Sign-in link sent to <span className="break-all text-gray-1000">{state.email}</span>. It
            expires in 15 minutes.
          </AuthDescription>
        </AuthHeader>
        <AuthContent className="items-center">
          <Button
            type="button"
            onClick={() => setState({ step: 'form', pending: null, error: null })}
          >
            Use a different email
          </Button>
          {mailpitUrl && (
            <a
              href={mailpitUrl}
              target="_blank"
              rel="noreferrer"
              className="text-copy-13 text-gray-900 underline underline-offset-4 hover:text-gray-1000"
            >
              Running locally? Open Mailpit
            </a>
          )}
        </AuthContent>
      </AuthPanel>
    );
  }

  return (
    <div>
      <AuthHeader className="mb-6">
        <AuthTitle>
          <h1>Welcome to Oat</h1>
        </AuthTitle>
      </AuthHeader>
      <div className="flex flex-col gap-5">
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          type="button"
          disabled={disabled}
          onClick={continueWithGoogle}
        >
          {pending === 'google' ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconBrandGoogle data-icon="inline-start" />
          )}
          Continue with Google
        </Button>

        <AuthDivider />

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const email = new FormData(event.currentTarget).get('email');
            if (typeof email === 'string' && email.trim()) void sendLink(email.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor="email">Work email</FieldLabel>
            <Input
              id="email"
              size="lg"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              disabled={disabled}
            />
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={disabled}>
            {pending === 'email' && <Spinner data-icon="inline-start" />}
            Email me a sign-in link
          </Button>
        </form>
      </div>

      {/* Live region stays mounted (announcements); it takes no space while empty. */}
      <p role="status" className="text-center text-copy-13 text-red-900 not-empty:mt-4">
        {state.error}
      </p>
    </div>
  );
}
