'use client';

import { createOatClient, fetchTransport } from '@oat/client';
import { FeatureUiProvider, type AppTarget, type LinkComponent } from '@oat/feature-ui';
import { serverSearchSource, searchPageHref } from '@oat/feature-ui/search';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { useShellData } from './shell-data';

const transport = fetchTransport();
const client = createOatClient(transport);
const searchSources = [serverSearchSource(client)];

const WebLink: LinkComponent = ({ href, ...props }) => <NextLink {...props} href={href as Route} />;

function hrefFor(target: AppTarget): string {
  switch (target.kind) {
    case 'document': {
      const params = new URLSearchParams();
      if (target.timeMs !== undefined) params.set('t', String(Math.floor(target.timeMs / 1000)));
      if (target.blockId) params.set('block', target.blockId);
      if (target.segmentId) params.set('seg', target.segmentId);
      return `/d/${encodeURIComponent(target.id)}${params.size ? `?${params}` : ''}`;
    }
    case 'search':
      return searchPageHref(target.q);
    case 'tasks':
      return '/tasks';
    case 'assistant':
      return target.threadId
        ? `/assistant?thread=${encodeURIComponent(target.threadId)}`
        : '/assistant';
  }
}

export function WebFeatureProvider({ children }: { children: React.ReactNode }) {
  const { workspace, user } = useShellData();
  const router = useRouter();
  const value = useMemo(
    () => ({
      client,
      transport,
      searchSources,
      workspaceId: workspace.id,
      user,
      hrefFor,
      Link: WebLink,
      navigate: (target: AppTarget) => router.push(hrefFor(target) as Route),
      notify: toast,
    }),
    [workspace.id, user, router],
  );
  return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
}
