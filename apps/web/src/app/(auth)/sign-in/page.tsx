import { AuthPanel, AuthContent } from '@oat/ui/components/auth-layout';
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
      <AuthPanel>
        <AuthContent>
          <SignInForm
            next={next}
            initialError={signInErrorMessage(error)}
            {...(mailpitUrl ? { mailpitUrl } : {})}
          />
        </AuthContent>
      </AuthPanel>
      <p className="text-center text-copy-13 text-gray-900">
        New here? Signing in creates your account.
      </p>
    </div>
  );
}
