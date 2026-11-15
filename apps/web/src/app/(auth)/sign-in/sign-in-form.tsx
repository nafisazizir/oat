'use client';

import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { ArrowLeftIcon, Loader2Icon, MailCheckIcon, MailIcon } from 'lucide-react';
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
      <div className="flex flex-col items-center gap-4 text-center" data-testid="magic-link-sent">
        <div className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <MailCheckIcon className="size-5" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p role="status" className="text-sm text-muted-foreground">
            We sent a sign-in link to{' '}
            <span className="font-medium text-foreground">{state.email}</span>. It works once and
            expires in 15 minutes.
          </p>
        </div>
        {mailpitUrl && (
          <a
            href={mailpitUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Running locally? Open Mailpit
          </a>
        )}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setState({ step: 'form', pending: null, error: null })}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-5">
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          type="button"
          disabled={disabled}
          onClick={continueWithGoogle}
        >
          {pending === 'google' && (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          )}
          Continue with Google
        </Button>

        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const email = new FormData(event.currentTarget).get('email');
            if (typeof email === 'string' && email.trim()) void sendLink(email.trim());
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              disabled={disabled}
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={disabled}>
            {pending === 'email' ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <MailIcon data-icon="inline-start" />
            )}
            Email me a sign-in link
          </Button>
        </form>
      </div>

      {/* Live region stays mounted (announcements); it takes no space while empty. */}
      <p role="status" className="text-center text-xs text-destructive not-empty:mt-4">
        {state.error}
      </p>
    </div>
  );
}
