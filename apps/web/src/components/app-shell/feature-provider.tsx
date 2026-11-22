'use client';

import { fetchTransport } from '@oat/client';
import { FeatureUiProvider } from '@oat/feature-ui';
import { createWorkspaceFeatureAdapter } from '@oat/feature-ui/workspace';
import { useShellData, useWorkspaceHost } from '@oat/workspace-ui';
import { useMemo } from 'react';
import { toast } from 'sonner';

const transport = fetchTransport();

export function WebFeatureProvider({ children }: { children: React.ReactNode }) {
  const host = useWorkspaceHost();
  const { workspace, user } = useShellData();
  const value = useMemo(
    () =>
      createWorkspaceFeatureAdapter(host, {
        transport,
        notify: toast,
        workspaceId: workspace.id,
        user,
      }),
    [host, workspace.id, user],
  );
  return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
}
