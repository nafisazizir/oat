'use client';

import {
  AssistantChat as SharedAssistantChat,
  type AssistantChatProps,
} from '@oat/feature-ui/assistant';
import { useSearchParams } from 'next/navigation';

export function AssistantChat(
  props: Omit<AssistantChatProps, 'selectedThreadId' | 'onThreadChange'>,
) {
  const params = useSearchParams();
  return (
    <SharedAssistantChat
      {...props}
      selectedThreadId={params.get('thread')}
      onThreadChange={(id) => {
        const url = new URL(window.location.href);
        if (id) url.searchParams.set('thread', id);
        else url.searchParams.delete('thread');
        window.history.replaceState(window.history.state, '', url);
      }}
    />
  );
}
