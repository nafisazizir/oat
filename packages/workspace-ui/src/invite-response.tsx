'use client';

import type { OatClient } from '@oat/client';
import type { InviteLanding } from '@oat/services/dto/workspaces';
import { ROLE_INFO } from '@oat/settings-ui/workspace';
import {
  AuthPanel,
  AuthHeader,
  AuthTitle,
  AuthDescription,
  AuthContent,
} from '@oat/ui/components/auth-layout';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { useEffect, useState, useTransition } from 'react';

export function InviteResponse({
  client,
  token,
  initial,
  onHome,
  onSwitchAccount,
  desktopUrl,
}: {
  client: OatClient;
  token: string;
  initial?: InviteLanding;
  onHome(joined?: boolean): void | Promise<void>;
  onSwitchAccount(): void | Promise<void>;
  desktopUrl?: string;
}) {
  const [invite, setInvite] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => {
    if (initial && revision === 0) return;
    let active = true;
    void client.invites.lookup(token).then(
      (next) => {
        if (active) setInvite(next);
      },
      (e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Couldn’t load the invitation.');
      },
    );
    return () => {
      active = false;
    };
  }, [client, token, initial, revision]);
  const run = (action: string, fn: () => void | Promise<void>) => {
    setError(null);
    setChoice(action);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Couldn’t respond to the invitation.');
      }
    });
  };
  const action = (label: string, fn: () => void | Promise<void>, ghost = false) => (
    <Button
      size="lg"
      className="w-full"
      variant={ghost ? 'ghost' : 'default'}
      disabled={pending}
      onClick={() => run(label, fn)}
    >
      {pending && choice === label && <Spinner data-icon="inline-start" />}
      {label}
    </Button>
  );
  let title = 'Invitation';
  let description = '';
  let content: React.ReactNode;
  let notice = true;
  if (!invite) {
    content = error ? (
      action('Try again', () => {
        setError(null);
        setRevision((v) => v + 1);
      })
    ) : (
      <p role="status">Loading invitation…</p>
    );
  } else if (invite.state === 'invalid') {
    title = 'This invitation isn’t valid';
    description =
      'The link may be incomplete, or the workspace no longer exists. Ask whoever invited you for a new one.';
  } else {
    const { workspace, inviter, email, state } = invite;
    if (state === 'expired') {
      title = 'This invitation has expired';
      description = `Invitations work for 7 days. Ask ${inviter} to send a new one.`;
    } else if (state === 'canceled') {
      title = 'This invitation was revoked';
      description = `Ask ${inviter} if you still need access to ${workspace.name}.`;
    } else if (state === 'rejected') {
      title = 'Invitation declined';
      description = `You won’t be added to ${workspace.name}. If you change your mind, ask ${inviter} to invite you again.`;
    } else if (state === 'accepted') {
      title = 'This invitation was already used';
      description = `Sign in as ${email} to open ${workspace.name}.`;
    } else {
      notice = false;
      title = `Join ${workspace.name}`;
      const role = ROLE_INFO[invite.role].label.toLowerCase();
      description = `${inviter} invited you to join as ${role === 'admin' ? 'an' : 'a'} ${role}.`;
      if (invite.access === 'wrong-account')
        content = (
          <>
            <p
              className="text-center text-copy-14 text-gray-900"
              data-testid="invite-wrong-account"
            >
              This invitation is for <span className="text-gray-1000">{email}</span>, but you’re
              signed in as <span className="text-gray-1000">{invite.viewerEmail}</span>.
            </p>
            {action('Sign in with a different account', onSwitchAccount)}
          </>
        );
      else if (invite.access === 'member')
        content = (
          <>
            <p className="text-center text-copy-14 text-gray-900">
              You’re already a member of {workspace.name}.
            </p>
            {action('Open workspace', async () => {
              await client.workspaces.switchActive(workspace.id);
              await onHome(true);
            })}
          </>
        );
      else
        content = (
          <>
            <p className="text-center text-copy-14 text-gray-900">
              You’re signed in as <span className="text-gray-1000">{invite.viewerEmail}</span>.
            </p>
            <div className="flex flex-col gap-3">
              {action('Accept invitation', async () => {
                await client.invites.accept(token);
                await onHome(true);
              })}
              {action(
                'Decline',
                async () => {
                  await client.invites.decline(token);
                  await onHome();
                },
                true,
              )}
            </div>
            {desktopUrl && (
              <a href={desktopUrl} className="text-center text-copy-13 text-gray-900 underline">
                Open in Oat desktop
              </a>
            )}
          </>
        );
    }
  }
  return (
    <AuthPanel data-testid={notice ? 'invite-notice' : 'invite-card'}>
      <AuthHeader className="text-center">
        <AuthTitle>
          <h1>{title}</h1>
        </AuthTitle>
        <AuthDescription>{description}</AuthDescription>
      </AuthHeader>
      <AuthContent className="gap-4">
        {content}
        {invite && notice && action('Go to Oat', onHome)}
        {error && (
          <p role="alert" className="text-center text-copy-14 text-red-900">
            {error}
          </p>
        )}
      </AuthContent>
    </AuthPanel>
  );
}
