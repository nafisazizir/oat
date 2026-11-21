import { DESKTOP_SIGN_IN_PATH, isDesktopAuthValue } from '@oat/auth/desktop-link';
import {
  AuthPanel,
  AuthContent,
  AuthDescription,
  AuthHeader,
  AuthTitle,
} from '@oat/ui/components/auth-layout';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';

import { desktopDevHandoff, serverEnv } from '@/lib/env';
import { signInPath } from '@/lib/redirect';
import { getSession } from '@/server/session';

import { DesktopHandoff } from './desktop-handoff';

export const metadata: Metadata = {
  title: 'Sign in to the Oat app',
  // The URL carries the app's sign-in state: no Referer to other sites, never indexed.
  referrer: 'same-origin',
  robots: { index: false, follow: false },
};

/**
 * Where the desktop app sends the browser to sign in (task 1.8; flow in `@oat/auth/desktop-link`).
 * Signed out → the normal sign-in, coming back here. Signed in → shows the account and a button that
 * asks `/api/auth/desktop/code` for a one-time code and opens `oat://auth?code=…&state=…`.
 */
export default async function DesktopSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const state = typeof params.state === 'string' ? params.state : '';
  const challenge = typeof params.challenge === 'string' ? params.challenge : '';

  if (!isDesktopAuthValue(state) || !isDesktopAuthValue(challenge)) {
    return (
      <AuthPanel>
        <AuthHeader>
          <AuthTitle>
            <h1>This link is incomplete</h1>
          </AuthTitle>
          <AuthDescription>Open Oat and choose “Sign in” again.</AuthDescription>
        </AuthHeader>
      </AuthPanel>
    );
  }

  const here = `${DESKTOP_SIGN_IN_PATH}?${new URLSearchParams({ state, challenge }).toString()}`;
  const session = await getSession();
  if (!session) redirect(signInPath(here) as Route);

  return (
    <AuthPanel>
      <AuthContent>
        <DesktopHandoff
          email={session.user.email}
          state={state}
          challenge={challenge}
          returnTo={here}
          devFallback={desktopDevHandoff(serverEnv())}
        />
      </AuthContent>
    </AuthPanel>
  );
}
