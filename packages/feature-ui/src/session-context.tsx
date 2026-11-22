'use client';

import { createContext, useCallback, useContext } from 'react';

import type { ChatSources, ResolvedCitation } from '@oat/services/dto/chat';
import { useFeatureUi } from './provider';
import { useAssistantIntegration } from './assistant-integration';

/** What a conversation's messages need from the session around them. */
export type ChatSessionApi = {
  threadId(): string | null;
  sources: ChatSources;
  /** Whether a message is the server's saved copy (its sources are resolved). */
  isSaved(messageId: string): boolean;
  /** Re-reads the thread (statuses, sources) from the server. */
  refresh(): Promise<void>;
  /** Asks a question again (a stale proposal's "Re-run"). */
  ask(text: string): void;
  busy: boolean;
};

export const ChatSessionContext = createContext<ChatSessionApi | null>(null);

export function useChatSession(): ChatSessionApi {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error('useChatSession outside a chat session');
  return value;
}

/**
 * Where a citation goes: a block of the open note is scrolled to and highlighted in place; a transcript moment
 * of the open note opens its transcript reader (URL `?t=&seg=`, no page change); anything else navigates to
 * that note.
 */
export function useOpenCitation() {
  const { navigate } = useFeatureUi();
  const integration = useAssistantIntegration();
  return useCallback(
    (citation: ResolvedCitation) => {
      if (integration.openCitation?.(citation)) return;
      navigate(
        citation.kind === 'block'
          ? { kind: 'document', id: citation.documentId, blockId: citation.id }
          : {
              kind: 'document',
              id: citation.documentId,
              segmentId: citation.id,
              timeMs: citation.startMs,
            },
      );
    },
    [integration, navigate],
  );
}
