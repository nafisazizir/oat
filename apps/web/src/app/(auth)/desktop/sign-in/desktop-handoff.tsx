'use client';

import { DESKTOP_CODE_ENDPOINT } from '@oat/auth/desktop-link';
import { Button } from '@oat/ui/components/button';
import { Alert, AlertDescription } from '@oat/ui/components/alert';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCheck, IconCopy, IconDeviceDesktop, IconShieldExclamation } from '@tabler/icons-react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';
import { signInPath } from '@/lib/redirect';
import { useHydrated } from '@/lib/use-hydrated';

type State =
  | { step: 'ready'; pending: boolean; error: string | null }
  | { step: 'opened'; url: string; copied: boolean };

/** Shown in every build: the page can be reached from a link someone else crafted (1.8 review). */
export const HANDOFF_WARNING =
  'Only continue if you just chose Sign in in the Oat app on this computer. Never share this link or code.';

/**
 * "Continue to the app": gets a one-time code for this account (cookie session, same-origin POST) and
 * hands it to the app through the `oat://` link. If the app doesn't open, the link can be opened again.
 * Development builds also offer to copy the link for the app's paste field (`devFallback`); production
 * never does, because a copyable code is something a phisher can ask for.
 */
export function DesktopHandoff({
  state,
  challenge,
  returnTo,
  devFallback,
}: {
  state: string;
  challenge: string;
  /** This page's path, to come back to after switching account. */
  returnTo: string;
  /** Development only (`desktopDevHandoff`): offer "Copy link for the app". */
  devFallback: boolean;
}) {
  const router = useRouter();
  const [ui, setUi] = useState<State>({ step: 'ready', pending: false, error: null });
  // Until hydrated, a click would do nothing (see useHydrated).
  const hydrated = useHydrated();

  async function continueToApp() {
    setUi({ step: 'ready', pending: true, error: null });
    const { data, error } = await authClient.$fetch<{ redirectUrl: string }>(
      DESKTOP_CODE_ENDPOINT,
      { method: 'POST', body: { state, challenge } },
    );
    if (error || !data) {
      setUi({
        step: 'ready',
        pending: false,
        error:
          error?.status === 401
            ? 'Your session ended. Reload this page to sign in again.'
            : 'Something went wrong. Start signing in again from the app.',
      });
      return;
    }
    setUi({ step: 'opened', url: data.redirectUrl, copied: false });
    window.location.href = data.redirectUrl;
  }

  async function switchAccount() {
    await authClient.signOut();
    router.replace(signInPath(returnTo) as Route);
  }

  if (ui.step === 'opened') {
    return (
      <Empty className="gap-5 p-0" data-testid="desktop-opened">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-brand-100 text-brand-900">
            <IconDeviceDesktop />
          </EmptyMedia>
          <EmptyTitle className="text-heading-16">
            <h2>Back to the app</h2>
          </EmptyTitle>
          <EmptyDescription role="status">
            Oat should open and finish signing in. You can close this tab.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="gap-1 text-copy-13 text-gray-900">
          <span>Didn’t open? Make sure Oat is running, then</span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => (window.location.href = ui.url)}
            >
              Open Oat again
            </Button>
            {devFallback && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(ui.url);
                  setUi({ ...ui, copied: true });
                }}
              >
                {ui.copied ? (
                  <IconCheck data-icon="inline-start" />
                ) : (
                  <IconCopy data-icon="inline-start" />
                )}
                {ui.copied ? 'Copied' : 'Copy link for the app (dev)'}
              </Button>
            )}
          </div>
          <span data-testid="desktop-never-share">
            Never share this link. Oat will never ask for it.
          </span>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert className="border-amber-400 bg-amber-100" data-testid="desktop-warning">
        <IconShieldExclamation className="text-amber-900" aria-hidden />
        <AlertDescription className="text-gray-1000">{HANDOFF_WARNING}</AlertDescription>
      </Alert>
      <Button
        size="lg"
        className="w-full"
        type="button"
        disabled={!hydrated || ui.pending}
        onClick={continueToApp}
      >
        {ui.pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <IconDeviceDesktop data-icon="inline-start" />
        )}
        Continue to the app
      </Button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled={!hydrated || ui.pending}
        onClick={switchAccount}
      >
        Use a different account
      </Button>
      <p role="status" className="text-center text-copy-13 text-red-900 empty:hidden">
        {ui.error}
      </p>
    </div>
  );
}
