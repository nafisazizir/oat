import { findInviteByToken, type InviteDetails } from '@oat/auth';
import { Button } from '@oat/ui/components/button';
import {
  AuthPanel,
  AuthContent,
  AuthDescription,
  AuthHeader,
  AuthTitle,
} from '@oat/ui/components/auth-layout';
import type { Metadata, Route } from 'next';
import Link from 'next/link';

import { WebInviteResponse } from '@/components/workspace/invite-response';
import { loadInviteLanding } from '@/server/invite-landing';
import { signInPath } from '@/lib/redirect';
import { ROLE_INFO } from '@/lib/workspace';
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
    <AuthPanel data-testid="invite-notice">
      <AuthHeader className="text-center">
        <AuthTitle>
          <h1>{title}</h1>
        </AuthTitle>
        <AuthDescription>{description}</AuthDescription>
      </AuthHeader>
      {action === 'home' && (
        <AuthContent>
          <Button
            role="link"
            nativeButton={false}
            render={<Link href="/home" />}
            size="lg"
            className="w-full"
          >
            Go to Oat
          </Button>
        </AuthContent>
      )}
    </AuthPanel>
  );
}

function InviteCard({ invite, children }: { invite: InviteDetails; children: React.ReactNode }) {
  const role = ROLE_INFO[invite.role].label.toLowerCase();
  return (
    <AuthPanel data-testid="invite-card">
      <AuthHeader className="items-center text-center">
        <AuthTitle>
          <h1>Join {invite.workspace.name}</h1>
        </AuthTitle>
        <AuthDescription>
          {invite.inviter.name} invited you to join as {role === 'admin' ? 'an' : 'a'} {role}.
        </AuthDescription>
      </AuthHeader>
      <AuthContent className="flex flex-col gap-4">{children}</AuthContent>
    </AuthPanel>
  );
}

/**
 * Where an invitation email lands (5.2). Anyone holding the link sees the workspace and inviter; only
 * the invited address, signed in (magic link or Google, both verified), can accept or decline.
 */
export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const session = await getSession();
  if (session)
    return (
      <WebInviteResponse
        token={token}
        initial={await loadInviteLanding(getDb(), token, session.user)}
      />
    );
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
  return (
    <InviteCard invite={invite}>
      <p className="text-center text-copy-14 text-gray-900">
        Sign in as <span className="text-gray-1000">{invite.email}</span> to accept. New to Oat?
        Signing in creates your account.
      </p>
      <Button
        role="link"
        nativeButton={false}
        render={<Link href={signInPath(here) as Route} />}
        size="lg"
        className="w-full"
      >
        Sign in to accept
      </Button>
    </InviteCard>
  );
}
