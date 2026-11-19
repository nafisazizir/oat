'use client';

import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import {
  FileTextIcon,
  HistoryIcon,
  MessageSquareIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api-client';
import { chatApi } from '@/lib/chat-client';
import type { ChatScope, ChatSources, ChatThreadSummary, ChatUIMessage } from '@/lib/chat-types';
import { formatDay } from '@/lib/format';

import { ChatSession } from './chat-session';

type Active =
  | {
      state: 'ready';
      key: string;
      /** The conversation's own scope: a note thread opened from /assistant stays about that note. */
      scope: ChatScope;
      threadId: string | null;
      messages: ChatUIMessage[];
      sources?: ChatSources;
    }
  | { state: 'loading'; key: string }
  | { state: 'error'; key: string; message: string };

const NOTE_SUGGESTIONS = [
  'Summarize this meeting in five bullets',
  'What did we decide, and who owns the next steps?',
  'What questions were left open?',
] as const;

const WORKSPACE_SUGGESTIONS = [
  'What did I discuss in meetings last week?',
  'List the open action items across my meetings',
  'What have customers said about pricing?',
] as const;

/**
 * The assistant with its conversations: a note's side panel (`layout="panel"`, scope = that note) or the
 * global Assistant page (`layout="page"`, scope = the workspace). Threads are private to the user (6.3); a new
 * conversation becomes a thread with its first question.
 */
export function AssistantChat({
  scope,
  workspaceId,
  layout,
  onClose,
}: {
  scope: ChatScope;
  workspaceId: string;
  layout: 'panel' | 'page';
  onClose?: () => void;
}) {
  const documentId = scope.kind === 'document' ? scope.documentId : undefined;
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null);
  const counter = useRef(0);
  const [active, setActive] = useState<Active>(() => ({
    state: 'ready',
    key: 'new-0',
    scope,
    threadId: null,
    messages: [],
  }));

  const loadThreads = useCallback(async () => {
    try {
      setThreads((await chatApi.threads(workspaceId, documentId)).threads);
    } catch {
      setThreads((current) => current ?? []);
    }
  }, [workspaceId, documentId]);

  useEffect(() => {
    let live = true;
    chatApi.threads(workspaceId, documentId).then(
      (res) => live && setThreads(res.threads),
      () => live && setThreads((current) => current ?? []),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, documentId]);

  const newChat = () => {
    counter.current += 1;
    setActive({
      state: 'ready',
      key: `new-${counter.current}`,
      scope,
      threadId: null,
      messages: [],
    });
  };

  const openThread = async (id: string) => {
    setActive({ state: 'loading', key: id });
    try {
      const detail = await chatApi.thread(id);
      const { thread } = detail;
      setActive({
        state: 'ready',
        key: id,
        // Follow-ups must use the thread's scope (the API refuses a different one).
        scope:
          thread.scope === 'document' && thread.documentId
            ? { kind: 'document', documentId: thread.documentId }
            : { kind: 'workspace', workspaceId: thread.workspaceId },
        threadId: id,
        messages: detail.messages,
        sources: detail.sources,
      });
    } catch (error) {
      setActive({
        state: 'error',
        key: id,
        message: isApiError(error, 'not_found')
          ? 'This conversation is no longer available.'
          : 'Couldn’t load this conversation.',
      });
      if (isApiError(error, 'not_found')) void loadThreads();
    }
  };

  const onThreadSaved = (threadId: string) => {
    // A new conversation got its thread: remember it (same session, no remount) and refresh the list.
    setActive((current) =>
      current.state === 'ready' && current.threadId === null ? { ...current, threadId } : current,
    );
    void loadThreads();
  };

  const activeThreadId = active.state === 'ready' ? active.threadId : active.key;
  const session =
    active.state === 'loading' ? (
      <div
        className="flex flex-1 flex-col gap-3 p-4"
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <Skeleton className="ml-auto h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    ) : active.state === 'error' ? (
      <div className="flex flex-1 flex-col items-start gap-3 p-4 text-sm" role="alert">
        <p>{active.message}</p>
        <Button size="sm" variant="outline" onClick={newChat}>
          Start a new conversation
        </Button>
      </div>
    ) : (
      <>
        {layout === 'page' && active.scope.kind === 'document' && (
          <p
            data-testid="note-thread-banner"
            className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"
          >
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="flex-1">
              This conversation is about one note; follow-ups stay within it.
            </span>
            <Link
              href={`/d/${active.scope.documentId}` as Route}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              Open note
            </Link>
          </p>
        )}
        <ChatSession
          key={`${active.scope.kind}:${active.key}`}
          scope={active.scope}
          threadId={active.threadId}
          initialMessages={active.messages}
          {...(active.sources ? { initialSources: active.sources } : {})}
          onThreadSaved={onThreadSaved}
          placeholder={
            active.scope.kind === 'document' ? 'Ask about this note…' : 'Ask about your meetings…'
          }
          suggestions={documentId ? NOTE_SUGGESTIONS : WORKSPACE_SUGGESTIONS}
          emptyTitle={documentId ? 'Ask about this note' : 'Ask across your meetings'}
          emptyDescription={
            documentId
              ? 'Answers come from this note and its transcript, with sources you can click.'
              : 'Answers come from the notes and transcripts you can see in this workspace.'
          }
          autoFocus={layout === 'panel'}
        />
      </>
    );

  if (layout === 'panel') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-4">
          <SparklesIcon className="size-4 text-primary" />
          <h2 className="flex-1 truncate text-sm font-medium">Ask about this note</h2>
          <ThreadMenu threads={threads} activeId={activeThreadId} onPick={openThread} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={newChat} />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
          {onClose && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close assistant"
                    onClick={onClose}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>Close · ⌘J</TooltipContent>
            </Tooltip>
          )}
        </header>
        {session}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Conversations"
        className="hidden w-64 shrink-0 flex-col gap-2 border-r p-3 md:flex"
      >
        <Button variant="outline" size="sm" className="justify-start" onClick={newChat}>
          <PlusIcon />
          New chat
        </Button>
        <ThreadList threads={threads} activeId={activeThreadId} onPick={openThread} />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-2 md:hidden">
          <ThreadMenu threads={threads} activeId={activeThreadId} onPick={openThread} />
          <Button variant="ghost" size="sm" onClick={newChat}>
            <PlusIcon />
            New chat
          </Button>
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">{session}</div>
      </div>
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onPick,
}: {
  threads: ChatThreadSummary[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  if (threads === null) {
    return (
      <div className="flex flex-col gap-2 px-1 py-2" aria-busy="true">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  if (threads.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</p>;
  }
  return (
    <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" data-testid="thread-list">
      {threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            onClick={() => onPick(thread.id)}
            aria-current={thread.id === activeId ? 'true' : undefined}
            className={cn(
              'flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              thread.id === activeId && 'bg-accent font-medium',
            )}
          >
            <span className="truncate">{thread.title || 'Untitled conversation'}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {thread.scope === 'document' ? 'About a note · ' : ''}
              {formatDay(thread.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ThreadMenu({
  threads,
  activeId,
  onPick,
}: {
  threads: ChatThreadSummary[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Previous chats" />}
            />
          }
        >
          <HistoryIcon />
        </TooltipTrigger>
        <TooltipContent>Previous chats</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Previous chats</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {threads === null ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : threads.length === 0 ? (
            <DropdownMenuItem disabled>No conversations yet</DropdownMenuItem>
          ) : (
            threads.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onClick={() => onPick(thread.id)}
                className={cn(thread.id === activeId && 'bg-accent')}
              >
                <MessageSquareIcon />
                <span className="flex-1 truncate">{thread.title || 'Untitled conversation'}</span>
                <span className="text-xs text-muted-foreground">{formatDay(thread.updatedAt)}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
