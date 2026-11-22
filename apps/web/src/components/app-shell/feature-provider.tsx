'use client';

import { fetchTransport } from '@oat/client';
import { FeatureUiProvider } from '@oat/feature-ui';
import { createWorkspaceFeatureAdapter } from '@oat/feature-ui/workspace';
import { serverSearchSource } from '@oat/feature-ui/search';
import { useShellData, useWorkspaceHost } from '@oat/workspace-ui';
import { useMemo } from 'react';
import { toast } from 'sonner';

const transport = fetchTransport();

export function WebFeatureProvider({ children }: { children: React.ReactNode }) {
  const host = useWorkspaceHost();
  const { client } = host;
  const { workspace, user } = useShellData();
  const searchSources = useMemo(() => [serverSearchSource(client)], [client]);
  const value = useMemo(
    () =>
      createWorkspaceFeatureAdapter(host, {
        transport,
        notify: toast,
        workspaceId: workspace.id,
        user,
        searchSources,
      }),
    [host, workspace.id, user, searchSources],
  );
  return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
}
