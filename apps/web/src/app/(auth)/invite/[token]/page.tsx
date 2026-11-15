import { findInviteByToken, type InviteDetails, loadPermissionContext } from '@oat/auth';
import { roleIn } from '@oat/core';
import { Button } from '@oat/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import type { Metadata, Route } from 'next';
import Link from 'next/link';

import {
  InviteResponse,
  OpenWorkspaceButton,
  SwitchAccountButton,
} from '@/components/workspace/invite-response';
import { WorkspaceAvatar } from '@/components/workspace/workspace-avatar';
import { signInPath } from '@/lib/redirect';
import { ROLE_INFO, workspaceIcon } from '@/lib/workspace';
import { getDb } from '@/server/db';
import { getSession } from '@/server/session';

export const metadata: Metadata = {
  title: 'Invitation',
  // The URL carries the invite's secret: never in a Referer (also sent as a header by `proxy.ts`),
  // never indexed.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ token: string }> };

function Notice({
  title,
  description,
  action = 'home',
}: {
  title: string;
  description: string;
  action?: 'home' | 'none';
}) {
  return (
    <Card className="shadow-md" data-testid="invite-notice">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          <h1>{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {action === 'home' && (
        <CardContent>
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link href="/home">Go to Oat</Link>
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

function InviteCard({ invite, children }: { invite: InviteDetails; children: React.ReactNode }) {
  const role = ROLE_INFO[invite.role].label.toLowerCase();
  return (
    <Card className="shadow-md" data-testid="invite-card">
      <CardHeader className="items-center text-center">
        <WorkspaceAvatar
          workspace={{
            name: invite.workspace.name,
            kind: 'team',
            icon: workspaceIcon(invite.workspace.logo),
          }}
          size="lg"
          className="mx-auto mb-2 size-12"
        />
        <CardTitle className="text-2xl">
          <h1>Join {invite.workspace.name}</h1>
        </CardTitle>
        <CardDescription>
          {invite.inviter.name} invited you to join as {role === 'admin' ? 'an' : 'a'} {role}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/**
 * Where an invitation email lands (5.2). Anyone holding the link sees the workspace and inviter; only
 * the invited address, signed in (magic link or Google, both verified), can accept or decline.
 */
export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const invite = await findInviteByToken(getDb(), token);

  if (!invite) {
    return (
      <Notice
        title="This invitation isn’t valid"
        description="The link may be incomplete, or the workspace no longer exists. Ask whoever invited you for a new one."
      />
    );
  }
  switch (invite.state) {
    case 'expired':
      return (
        <Notice
          title="This invitation has expired"
          description={`Invitations work for 7 days. Ask ${invite.inviter.name} to send a new one.`}
        />
      );
    case 'canceled':
      return (
        <Notice
          title="This invitation was revoked"
          description={`Ask ${invite.inviter.name} if you still need access to ${invite.workspace.name}.`}
        />
      );
    case 'rejected':
      return (
        <Notice
          title="Invitation declined"
          description={`You won’t be added to ${invite.workspace.name}. If you change your mind, ask ${invite.inviter.name} to invite you again.`}
        />
      );
    case 'accepted':
      return (
        <Notice
          title="This invitation was already used"
          description={`Sign in as ${invite.email} to open ${invite.workspace.name}.`}
        />
      );
    case 'pending':
      break;
  }

  const here = `/invite/${encodeURIComponent(token)}`;
  const session = await getSession();

  if (!session) {
    return (
      <InviteCard invite={invite}>
        <p className="text-center text-sm text-muted-foreground">
          Sign in as <span className="font-medium text-foreground">{invite.email}</span> to accept.
          New to Oat? Signing in creates your account.
        </p>
        <Button asChild size="lg" className="w-full">
          <Link href={signInPath(here) as Route}>Sign in to accept</Link>
        </Button>
      </InviteCard>
    );
  }

  if (session.user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <InviteCard invite={invite}>
        <p className="text-center text-sm text-muted-foreground" data-testid="invite-wrong-account">
          This invitation is for <span className="font-medium text-foreground">{invite.email}</span>
          , but you’re signed in as{' '}
          <span className="font-medium text-foreground">{session.user.email}</span>.
        </p>
        <SwitchAccountButton next={signInPath(here) as Route} />
      </InviteCard>
    );
  }

  const ctx = await loadPermissionContext(getDb(), session.user.id);
  if (roleIn(ctx, invite.workspace.id) !== undefined) {
    return (
      <InviteCard invite={invite}>
        <p className="text-center text-sm text-muted-foreground">
          You’re already a member of {invite.workspace.name}.
        </p>
        <OpenWorkspaceButton workspaceId={invite.workspace.id} />
      </InviteCard>
    );
  }

  return (
    <InviteCard invite={invite}>
      <p className="text-center text-sm text-muted-foreground">
        You’re signed in as{' '}
        <span className="font-medium text-foreground">{session.user.email}</span>.
      </p>
      <InviteResponse token={token} />
    </InviteCard>
  );
}
