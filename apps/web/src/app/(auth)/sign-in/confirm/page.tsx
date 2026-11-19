import { MAGIC_LINK_CONSUME_PATH } from '@oat/auth/magic-link';
import { peekMagicLinkEmail } from '@oat/auth/magic-link-lookup';
import { Button } from '@oat/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import { LogInIcon } from 'lucide-react';
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
      <Card className="shadow-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>{token ? 'This link has expired' : 'This link is incomplete'}</h1>
          </CardTitle>
          <CardDescription>
            {token
              ? 'Sign-in links work once and expire after 15 minutes. Request a new one.'
              : 'Copy the whole link from the email, or request a new one.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            role="link"
            nativeButton={false}
            render={<Link href="/sign-in" />}
            variant="outline"
            size="lg"
            className="w-full"
          >
            Back to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          <h1>Finish signing in</h1>
        </CardTitle>
        <CardDescription>
          You’re signing in to Oat as
          <span
            className="my-1 block font-medium break-all text-foreground"
            data-testid="confirm-email"
          >
            {email}
          </span>
          Not you? Just close this page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action={MAGIC_LINK_CONSUME_PATH} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" size="lg" className="w-full">
            <LogInIcon data-icon="inline-start" />
            Continue to Oat
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
