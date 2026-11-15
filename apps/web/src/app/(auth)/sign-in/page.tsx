import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';

import { serverEnv } from '@/lib/env';
import { safeNextPath } from '@/lib/redirect';
import { signInErrorMessage } from '@/lib/sign-in-errors';
import { getSession } from '@/server/session';

import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  // Already signed in: go where they were heading.
  if (await getSession()) redirect(next as Route);

  const error = typeof params.error === 'string' ? params.error : undefined;
  const env = serverEnv();
  const mailpitUrl = env.NODE_ENV === 'development' ? env.MAILPIT_URL : undefined;

  return (
    <div className="flex flex-col gap-6">
      <Card className="shadow-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>Welcome to Oat</h1>
          </CardTitle>
          <CardDescription>Sign in to your notes and workspaces.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm
            next={next}
            initialError={signInErrorMessage(error)}
            {...(mailpitUrl ? { mailpitUrl } : {})}
          />
        </CardContent>
      </Card>
      <p className="px-6 text-center text-xs text-muted-foreground">
        New here? Signing in creates your personal workspace.
      </p>
    </div>
  );
}
