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
import { Alert, AlertAction, AlertDescription } from '@oat/ui/components/alert';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@oat/ui/components/item';
import { Kbd, KbdGroup } from '@oat/ui/components/kbd';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import {
  IconAlertCircle,
  IconFileText,
  IconHistory,
  IconMessage,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError, describeChatError } from './chat-client';
import { TargetLink, useFeatureUi } from './provider';
import type {
  ChatScope,
  ChatSources,
  ChatThreadSummary,
  ChatUIMessage,
} from '@oat/services/dto/chat';
import { formatDay } from './format';

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
export type AssistantChatProps = {
  scope: ChatScope;
  workspaceId: string;
  layout: 'panel' | 'page';
  onClose?: () => void;
  selectedThreadId?: string | null;
  onThreadChange?(id: string | null): void;
};

export function AssistantChat({
  scope,
  workspaceId,
  layout,
  onClose,
  selectedThreadId,
  onThreadChange,
}: AssistantChatProps) {
  const { client } = useFeatureUi();
  const listRequest = useRef<AbortController | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const documentId = scope.kind === 'document' ? scope.documentId : undefined;
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null);
  const counter = useRef(0);
  const [active, setActive] = useState<Active>(() =>
    selectedThreadId
      ? { state: 'loading', key: selectedThreadId }
      : { state: 'ready', key: 'new-0', scope, threadId: null, messages: [] },
  );

  const [previousSelection, setPreviousSelection] = useState(selectedThreadId);
  if (selectedThreadId !== previousSelection) {
    setPreviousSelection(selectedThreadId);
    const currentId = active.state === 'ready' ? active.threadId : active.key;
    if (selectedThreadId !== undefined && selectedThreadId !== currentId) {
      setActive(
        selectedThreadId
          ? { state: 'loading', key: selectedThreadId }
          : { state: 'ready', key: `new-${active.key}`, scope, threadId: null, messages: [] },
      );
    }
  }

  const loadThreads = useCallback(() => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const { signal } = controller;
    return client.chat
      .threads({ workspaceId, ...(documentId ? { documentId } : {}) }, { signal })
      .then(
        (result) => {
          if (signal.aborted) return;
          setThreads(result.threads);
          setThreadError(null);
        },
        (error) => {
          if (signal.aborted) return;
          setThreads((current) => current ?? []);
          setThreadError(describeChatError(error).message);
        },
      );
  }, [client, workspaceId, documentId]);

  useEffect(() => {
    void loadThreads();
    return () => listRequest.current?.abort();
  }, [loadThreads]);

  const newChat = () => {
    onThreadChange?.(null);
    counter.current += 1;
    setActive({
      state: 'ready',
      key: `new-${counter.current}`,
      scope,
      threadId: null,
      messages: [],
    });
  };

  const loadingThreadId = active.state === 'loading' ? active.key : null;
  useEffect(() => {
    if (!loadingThreadId) return;
    const controller = new AbortController();
    const id = loadingThreadId;
    client.chat.thread(id, { signal: controller.signal }).then(
      (detail) => {
        if (controller.signal.aborted) return;
        const { thread } = detail;
        setActive({
          state: 'ready',
          key: id,
          scope:
            thread.scope === 'document' && thread.documentId
              ? { kind: 'document', documentId: thread.documentId }
              : { kind: 'workspace', workspaceId: thread.workspaceId },
          threadId: id,
          messages: detail.messages,
          sources: detail.sources,
        });
      },
      (error) => {
        if (controller.signal.aborted) return;
        setActive({
          state: 'error',
          key: id,
          message: isApiError(error, 'not_found')
            ? 'This conversation is no longer available.'
            : describeChatError(error).message,
        });
        if (isApiError(error, 'not_found')) void loadThreads();
      },
    );
    return () => controller.abort();
  }, [client, loadingThreadId, loadThreads]);

  const pickThread = (id: string) => {
    setActive({ state: 'loading', key: id });
    onThreadChange?.(id);
  };

  const onThreadSaved = (threadId: string) => {
    onThreadChange?.(threadId);
    // A new conversation got its thread: remember it (same session, no remount) and refresh the list.
    setActive((current) =>
      current.state === 'ready' && current.threadId === null ? { ...current, threadId } : current,
    );
    void loadThreads();
  };

  const activeThreadId = active.state === 'ready' ? active.threadId : active.key;
  const listError = threadError ? (
    <Alert role="alert" className="mx-3 my-2">
      <IconAlertCircle />
      <AlertDescription>{threadError}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="ghost" onClick={() => void loadThreads()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  ) : null;
  const session =
    active.state === 'loading' ? (
      <div
        className="flex flex-1 flex-col gap-6 p-4"
        role="status"
        aria-busy="true"
        aria-label="Loading conversation"
      >
        <Skeleton className="ms-auto h-9 w-2/3 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    ) : active.state === 'error' ? (
      <div className="p-4">
        <Alert role="alert">
          <IconAlertCircle />
          <AlertDescription>{active.message}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={newChat}>
              New chat
            </Button>
          </AlertAction>
        </Alert>
      </div>
    ) : (
      <>
        {layout === 'page' && active.scope.kind === 'document' && (
          <p
            data-testid="note-thread-banner"
            className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-copy-13 text-gray-900"
          >
            <IconFileText aria-hidden className="size-4 shrink-0" />
            <span className="flex-1">About one note; follow-ups stay within it.</span>
            <TargetLink
              target={{ kind: 'document', id: active.scope.documentId }}
              className="text-label-13 text-gray-1000 underline-offset-2 hover:underline"
            >
              Open note
            </TargetLink>
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
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-alpha-400 ps-4 pe-2">
          <h2 className="flex-1 truncate text-heading-14">Assistant</h2>
          <ThreadMenu threads={threads} activeId={activeThreadId} onPick={pickThread} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={newChat} />
              }
            >
              <IconPlus />
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
                <IconX />
              </TooltipTrigger>
              <TooltipContent>
                Close
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <Kbd>J</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
          )}
        </header>
        {listError}
        {session}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Conversations"
        className="hidden w-60 shrink-0 flex-col gap-2 bg-gray-alpha-100 p-3 md:flex"
      >
        <Button variant="ghost" size="sm" className="justify-start" onClick={newChat}>
          <IconPlus data-icon="inline-start" />
          New chat
        </Button>
        {listError}
        <ThreadList threads={threads} activeId={activeThreadId} onPick={pickThread} />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-gray-alpha-400 px-4 py-2 md:hidden">
          <ThreadMenu threads={threads} activeId={activeThreadId} onPick={pickThread} />
          <Button variant="ghost" size="sm" onClick={newChat}>
            <IconPlus data-icon="inline-start" />
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
      <div className="flex flex-col gap-0.5" role="status" aria-label="Loading conversations">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1 px-2.5 py-2">
            <Skeleton className="my-0.5 h-4 w-4/5" />
            <Skeleton className="my-0.5 h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }
  if (threads.length === 0) {
    return <p className="px-2.5 py-2 text-copy-13 text-gray-900">No conversations yet.</p>;
  }
  return (
    <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" data-testid="thread-list">
      {threads.map((thread) => (
        <li key={thread.id}>
          <Item
            size="xs"
            render={<button type="button" />}
            onClick={() => onPick(thread.id)}
            aria-current={thread.id === activeId ? 'true' : undefined}
            className="text-start hover:bg-gray-alpha-100 active:bg-gray-alpha-200 aria-[current=true]:bg-gray-alpha-200"
          >
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="w-full truncate text-label-14">
                {thread.title || 'Untitled conversation'}
              </ItemTitle>
              <ItemDescription className="text-copy-13 tabular-nums">
                {thread.scope === 'document' ? 'About a note · ' : ''}
                {formatDay(thread.updatedAt)}
              </ItemDescription>
            </ItemContent>
          </Item>
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
          <IconHistory />
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
                className={cn(thread.id === activeId && 'bg-gray-alpha-200')}
              >
                <IconMessage />
                <span className="flex-1 truncate">{thread.title || 'Untitled conversation'}</span>
                <span className="text-copy-13 text-gray-900 tabular-nums">
                  {formatDay(thread.updatedAt)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
