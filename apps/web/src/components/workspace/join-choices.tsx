'use client';

import { createOatClient, fetchTransport } from '@oat/client';
import { JoinWorkspace, type JoinSnapshot } from '@oat/workspace-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

const client = createOatClient(fetchTransport());

export function WebJoinWorkspace({ email, initial }: { email: string; initial: JoinSnapshot }) {
  const router = useRouter();
  const onHome = useCallback(() => {
    router.replace('/home');
    router.refresh();
  }, [router]);
  return (
    <JoinWorkspace
      client={client}
      email={email}
      initial={initial}
      onHome={onHome}
      homeLink={<Link href="/home" />}
    />
  );
}
