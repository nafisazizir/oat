'use client';

import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { authClient } from '@/lib/auth-client';
import { acceptInvite, declineInvite } from '@/server/actions/members';
import { switchWorkspace } from '@/server/actions/workspaces';

/** Accept / Decline for the invited, signed-in address. Accepting lands on Home in the workspace. */
export function InviteResponse({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<'accept' | 'decline' | null>(null);

  const respond = (which: 'accept' | 'decline') => {
    setChoice(which);
    startTransition(async () => {
      const result = await (which === 'accept' ? acceptInvite(token) : declineInvite(token));
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Button size="lg" className="w-full" disabled={pending} onClick={() => respond('accept')}>
        {pending && choice === 'accept' && <Spinner data-icon="inline-start" />}
        Accept invitation
      </Button>
      <Button
        size="lg"
        variant="ghost"
        className="w-full"
        disabled={pending}
        onClick={() => respond('decline')}
      >
        {pending && choice === 'decline' && <Spinner data-icon="inline-start" />}
        Decline
      </Button>
      {error && (
        <p role="alert" className="text-center text-copy-14 text-red-900">
          {error}
        </p>
      )}
    </div>
  );
}

/** Signed in as someone else: sign out, then sign in again with the invited address. */
export function SwitchAccountButton({ next }: { next: Route }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="lg"
      variant="outline"
      className="w-full"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await authClient.signOut();
          router.replace(next);
          router.refresh();
        })
      }
    >
      {pending && <Spinner data-icon="inline-start" />}
      Sign in with a different account
    </Button>
  );
}

/** Already a member: make that workspace active and go Home. */
export function OpenWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="lg"
      className="w-full"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await switchWorkspace(workspaceId);
          router.push('/home');
        })
      }
    >
      {pending && <Spinner data-icon="inline-start" />}
      Open workspace
    </Button>
  );
}
