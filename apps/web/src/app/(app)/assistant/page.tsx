import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AssistantChat } from '@/components/assistant/assistant-chat';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Assistant' };

/**
 * `/assistant`: chat across the active workspace's notes and transcripts (6.4, scope = workspace). Each
 * conversation is a private thread; answers cite transcript moments and note blocks.
 */
export default async function AssistantPage() {
  const { workspace } = await getShellData();
  return (
    <div className="flex h-[calc(100svh-3rem)] min-h-0 flex-col" data-testid="assistant-page">
      <Suspense
        fallback={
          <p className="p-4 text-copy-14 text-gray-900" role="status">
            Loading assistant…
          </p>
        }
      >
        <AssistantChat
          key={workspace.id}
          scope={{ kind: 'workspace', workspaceId: workspace.id }}
          workspaceId={workspace.id}
          layout="page"
        />
      </Suspense>
    </div>
  );
}
