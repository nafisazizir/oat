'use client';

import { createOatClient, fetchTransport } from '@oat/client';
import { desktopInviteUrl } from '@oat/core/invite-link';
import type { InviteLanding } from '@oat/services/dto/workspaces';
import { InviteResponse } from '@oat/workspace-ui';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { authClient } from '@/lib/auth-client';
import { signInPath } from '@/lib/redirect';

const client = createOatClient(fetchTransport());

export function WebInviteResponse({ token, initial }: { token: string; initial: InviteLanding }) {
  const router = useRouter();
  return (
    <InviteResponse
      key={token}
      client={client}
      token={token}
      initial={initial}
      desktopUrl={desktopInviteUrl(token) ?? undefined}
      onHome={() => {
        router.replace('/home');
        router.refresh();
      }}
      onSwitchAccount={async () => {
        await authClient.signOut();
        router.replace(signInPath(`/invite/${encodeURIComponent(token)}`) as Route);
        router.refresh();
      }}
    />
  );
}
