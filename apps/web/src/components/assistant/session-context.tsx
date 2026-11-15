'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext } from 'react';

import type { ChatSources, ResolvedCitation } from '@/lib/chat-types';
import { blockHref, segmentHref } from '@/lib/transcript';

import { useOpenDocument } from './open-document';

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
  const router = useRouter();
  const open = useOpenDocument();
  return useCallback(
    (citation: ResolvedCitation) => {
      const here = open?.documentId === citation.documentId;
      if (citation.kind === 'block') {
        if (here) open.showBlock(citation.id);
        else router.push(blockHref(citation.documentId, citation.id) as Route);
        return;
      }
      const href = segmentHref(citation.documentId, citation.startMs, citation.id) as Route;
      if (here) router.replace(href, { scroll: false });
      else router.push(href);
    },
    [open, router],
  );
}
