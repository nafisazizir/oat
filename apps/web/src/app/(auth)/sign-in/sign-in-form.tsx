'use client';

import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Field, FieldLabel, FieldSeparator } from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import { Spinner } from '@oat/ui/components/spinner';
import { IconArrowLeft, IconBrandGoogle, IconMail, IconMailCheck } from '@tabler/icons-react';
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
      <Empty className="gap-5 p-0" data-testid="magic-link-sent">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-brand-100 text-brand-900">
            <IconMailCheck />
          </EmptyMedia>
          <EmptyTitle className="text-heading-16">
            <h2>Check your email</h2>
          </EmptyTitle>
          <EmptyDescription role="status">
            We sent a sign-in link to <span className="text-gray-1000">{state.email}</span>. It
            works once and expires in 15 minutes.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
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
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setState({ step: 'form', pending: null, error: null })}
          >
            <IconArrowLeft data-icon="inline-start" />
            Use a different email
          </Button>
        </EmptyContent>
      </Empty>
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
          {pending === 'google' ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconBrandGoogle data-icon="inline-start" />
          )}
          Continue with Google
        </Button>

        <FieldSeparator aria-hidden className="text-label-12">
          or
        </FieldSeparator>

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
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              disabled={disabled}
            />
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={disabled}>
            {pending === 'email' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconMail data-icon="inline-start" />
            )}
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
