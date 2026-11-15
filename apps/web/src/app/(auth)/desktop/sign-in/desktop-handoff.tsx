'use client';

import { DESKTOP_CODE_ENDPOINT } from '@oat/auth/desktop-link';
import { Button } from '@oat/ui/components/button';
import { CheckIcon, CopyIcon, Loader2Icon, MonitorIcon, ShieldAlertIcon } from 'lucide-react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';
import { signInPath } from '@/lib/redirect';

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
      <div className="flex flex-col items-center gap-4 text-center" data-testid="desktop-opened">
        <div className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <MonitorIcon className="size-5" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold">Back to the app</h2>
          <p role="status" className="text-sm text-muted-foreground">
            Oat should open and finish signing in. You can close this tab.
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
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
                  <CheckIcon data-icon="inline-start" />
                ) : (
                  <CopyIcon data-icon="inline-start" />
                )}
                {ui.copied ? 'Copied' : 'Copy link for the app (dev)'}
              </Button>
            )}
          </div>
          <span data-testid="desktop-never-share">
            Never share this link. Oat will never ask for it.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p
        className="flex items-start gap-2 rounded-lg bg-warning/15 p-3 text-left text-xs text-foreground"
        data-testid="desktop-warning"
      >
        <ShieldAlertIcon className="mt-px size-4 shrink-0 text-warning-foreground" aria-hidden />
        {HANDOFF_WARNING}
      </p>
      <Button
        size="lg"
        className="w-full"
        type="button"
        disabled={ui.pending}
        onClick={continueToApp}
      >
        {ui.pending ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <MonitorIcon data-icon="inline-start" />
        )}
        Continue to the app
      </Button>
      <Button variant="ghost" size="sm" type="button" disabled={ui.pending} onClick={switchAccount}>
        Use a different account
      </Button>
      <p role="status" className="text-center text-xs text-destructive empty:hidden">
        {ui.error}
      </p>
    </div>
  );
}
