import { MAGIC_LINK_CONSUME_PATH } from '@oat/auth/magic-link';
import { peekMagicLinkEmail } from '@oat/auth/magic-link-lookup';
import { Button } from '@oat/ui/components/button';
import {
  AuthPanel,
  AuthContent,
  AuthDescription,
  AuthHeader,
  AuthTitle,
} from '@oat/ui/components/auth-layout';
import { IconLogin } from '@tabler/icons-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { safeNextPath } from '@/lib/redirect';
import { getDb } from '@/server/db';

export const metadata: Metadata = {
  title: 'Finish signing in',
  // The URL carries a one-time token: no Referer to other sites, never indexed. (`no-referrer` would also
  // turn the form POST's Origin into `null`.)
  referrer: 'same-origin',
  robots: { index: false, follow: false },
};

/**
 * Where the emailed magic link lands. Opening it (GET) consumes nothing, so mail scanners that prefetch
 * links can't use it up. It shows which address the link signs in as, and the button POSTs the token to
 * `/api/sign-in/magic-link`, which signs in and redirects to `next`.
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const next = safeNextPath(params.next);
  // Which account this link signs into (read-only: the token stays unused until the POST).
  const email = token ? await peekMagicLinkEmail(getDb(), token) : undefined;

  if (!email) {
    return (
      <AuthPanel>
        <AuthHeader className="text-center">
          <AuthTitle>
            <h1>{token ? 'This link has expired' : 'This link is incomplete'}</h1>
          </AuthTitle>
          <AuthDescription>Request a new sign-in link.</AuthDescription>
        </AuthHeader>
        <AuthContent>
          <Button
            role="link"
            nativeButton={false}
            render={<Link href="/sign-in" />}
            size="lg"
            className="w-full"
          >
            Back to sign in
          </Button>
        </AuthContent>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel>
      <AuthHeader className="text-center">
        <AuthTitle>
          <h1>Finish signing in</h1>
        </AuthTitle>
        <AuthDescription>
          You’re signing in to Oat as
          <span className="my-1 block break-all text-gray-1000" data-testid="confirm-email">
            {email}
          </span>
          Not you? Just close this page.
        </AuthDescription>
      </AuthHeader>
      <AuthContent>
        <form method="post" action={MAGIC_LINK_CONSUME_PATH} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" size="lg" className="w-full">
            <IconLogin data-icon="inline-start" />
            Continue to Oat
          </Button>
        </form>
      </AuthContent>
    </AuthPanel>
  );
}
