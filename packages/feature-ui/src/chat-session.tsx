'use client';

import { useChat } from '@ai-sdk/react';
import { toFetch, type OatTransport } from '@oat/client';
import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { cn } from '@oat/ui/lib/utils';
import { Button } from '@oat/ui/components/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@oat/ui/components/input-group';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@oat/ui/components/message-scroller';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconArrowUp,
  IconCornerDownLeft,
  IconPlayerStopFilled,
  IconX,
} from '@tabler/icons-react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { describeChatError } from './chat-client';
import { DockControlsOutlet } from './note-dock-controls';
import { useFeatureUi } from './provider';
import type { ChatScope, ChatSources, ChatUIMessage } from '@oat/services/dto/chat';

import { AssistantMessage, UserMessage } from './chat-message';
import { ChatSessionContext, type ChatSessionApi } from './session-context';
import { useAssistantIntegration } from './assistant-integration';

/** Mirrors the server's per-message limit (`CHAT_LIMITS.userChars`). */
const MAX_QUESTION_CHARS = 8000;
const EMPTY_SOURCES: ChatSources = { citations: {}, documents: {} };
const RECIPE_LABELS = ['Summarize meeting', 'Decisions & next steps', 'Open questions'];
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });

/** Where a session keeps its thread id: set from the first answer's response header. */
type ThreadHolder = { current: string | null };

/**
 * The AI SDK transport for one session. Only the new question goes out (the server loads the history from
 * the thread, D-27); the thread id comes back as a header before any token, so later turns continue it.
 */
function createTransport(
  scope: ChatScope,
  thread: ThreadHolder,
  transport: OatTransport,
  beforeSend: () => Promise<void>,
) {
  const fetch = toFetch(transport);
  return new DefaultChatTransport<ChatUIMessage>({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        ...(thread.current ? { threadId: thread.current } : {}),
        scope,
        messages: messages.slice(-1),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }),
    fetch: async (input, init) => {
      init?.signal?.throwIfAborted();
      await beforeSend();
      init?.signal?.throwIfAborted();
      const res = await fetch(input, init);
      const id = res.headers.get('x-oat-thread-id');
      if (id && !thread.current) thread.current = id;
      return res;
    },
  });
}

export type ChatSessionProps = {
  scope: ChatScope;
  /** The saved thread this session continues; `null` for a new conversation. */
  threadId: string | null;
  initialMessages?: ChatUIMessage[];
  initialSources?: ChatSources;
  /** A new thread was created by the first question, or a turn was saved (refresh thread lists). */
  onThreadSaved?: (threadId: string) => void;
  onBusyChange?: (busy: boolean) => void;
  placeholder: string;
  suggestions: readonly string[];
  emptyTitle: string;
  emptyDescription: string;
  layout?: 'page' | 'panel' | 'dock';
  /** Focus the question box on mount. */
  autoFocus?: boolean;
};

/**
 * One conversation: the AI SDK `useChat` over our UI message stream (`POST /api/chat`). Only the new question
 * is sent (the server keeps the history, D-27). When a turn ends, the saved thread is read back so citations
 * resolve against current access and proposals carry their server-side status.
 */
export function ChatSession({
  scope,
  threadId: initialThreadId,
  initialMessages = [],
  initialSources = EMPTY_SOURCES,
  onThreadSaved,
  onBusyChange,
  placeholder,
  suggestions,
  emptyTitle,
  emptyDescription,
  layout = 'page',
  autoFocus,
}: ChatSessionProps) {
  const { client, transport: hostTransport } = useFeatureUi();
  const integration = useAssistantIntegration();
  const lifecycle = useRef<AbortController | null>(null);
  // Mutable on purpose (set by the transport); never read during render.
  const [thread] = useState<ThreadHolder>(() => ({ current: initialThreadId }));
  const [sources, setSources] = useState<ChatSources>(initialSources);
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialMessages.map((m) => m.id)),
  );
  const onSaved = useRef(onThreadSaved);
  useEffect(() => {
    onSaved.current = onThreadSaved;
  });
  const [announcement, setAnnouncement] = useState('');
  const refreshRef = useRef<(expectMessageId?: string) => Promise<void>>(async () => {});
  const finishedMessage = useRef<string | null>(null);

  const transport = useMemo(
    () =>
      createTransport(scope, thread, hostTransport, async () => {
        await integration.beforeSend?.(scope);
      }),
    [scope, thread, hostTransport, integration],
  );

  const chat = useChat<ChatUIMessage>({
    transport,
    messages: initialMessages,
    onFinish: ({ message, isAbort, isError }) => {
      if (lifecycle.current?.signal.aborted) return;
      if (message.metadata?.threadId) finishedMessage.current = message.id;
      // One announcement per turn for screen readers (the streamed text itself is not a live region).
      setAnnouncement(isAbort ? 'Stopped.' : isError ? '' : 'Answer ready.');
    },
  });
  const { messages, status, error, sendMessage, stop, setMessages, clearError } = chat;
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => {
      controller.abort();
      void stop();
    };
  }, [stop]);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });

  const refresh = useCallback(
    async (expectMessageId?: string) => {
      const id = thread.current;
      const signal = lifecycle.current?.signal;
      if (!id || !signal || signal.aborted) return;
      for (let attempt = 0; attempt < 30; attempt++) {
        const detail = await client.chat.thread(id, { signal }).catch(() => null);
        if (signal.aborted) return;
        if (detail && (!expectMessageId || detail.messages.some((m) => m.id === expectMessageId))) {
          // Don't clobber a turn that started meanwhile.
          if (statusRef.current === 'ready' || statusRef.current === 'error') {
            setMessages(detail.messages);
            setSavedIds(new Set(detail.messages.map((m) => m.id)));
          }
          setSources(detail.sources);
          onSaved.current?.(id);
          return;
        }
        await sleep(Math.min(100 * (attempt + 1), 500), signal);
      }
    },
    [setMessages, thread, client],
  );
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const busy = status === 'submitted' || status === 'streaming';
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (busy || !finishedMessage.current) return;
    const id = finishedMessage.current;
    finishedMessage.current = null;
    void refreshRef.current(id);
  });
  const ask = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question || busy) return;
      clearError();
      setAnnouncement('The assistant is answering…');
      void sendMessage({ text: question.slice(0, MAX_QUESTION_CHARS) });
    },
    [busy, clearError, sendMessage],
  );

  const api: ChatSessionApi = useMemo(
    () => ({
      threadId: () => thread.current,
      sources,
      isSaved: (id) => savedIds.has(id),
      refresh: () => refresh(),
      ask,
      busy,
    }),
    [sources, savedIds, refresh, ask, busy, thread],
  );

  const failure = error ? describeChatError(error) : null;
  const last = messages.at(-1);

  return (
    <ChatSessionContext.Provider value={api}>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          messages.length === 0 && 'justify-center overflow-y-auto',
        )}
        data-testid="chat-session"
        data-status={status}
        data-empty={messages.length === 0}
      >
        <p role="status" className="sr-only" data-testid="chat-status">
          {announcement}
        </p>
        {messages.length === 0 ? (
          layout === 'dock' ? null : (
            <EmptyChat title={emptyTitle} description={emptyDescription} layout={layout} />
          )
        ) : (
          <MessageList
            messages={messages}
            busy={busy}
            lastId={last?.id}
            answerActions={layout === 'dock'}
          >
            {status === 'submitted' && last?.role === 'user' && (
              <p className="flex items-center gap-1.5 text-label-13 text-gray-900">
                <Spinner aria-hidden role={undefined} className="size-3.5" />
                Thinking…
              </p>
            )}
            {failure && (
              <Alert
                variant="destructive"
                role="alert"
                data-testid="chat-error"
                data-kind={failure.kind}
              >
                <IconAlertCircle />
                <AlertDescription>{failure.message}</AlertDescription>
              </Alert>
            )}
          </MessageList>
        )}
        {layout !== 'dock' && (
          <Composer
            busy={busy}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onSend={ask}
            onStop={() => void stop()}
          />
        )}
        {(layout === 'dock' || messages.length === 0) && (
          <div
            className={cn(
              'flex shrink-0 gap-1',
              layout === 'dock' ? 'overflow-x-auto p-2' : 'flex-wrap justify-center px-4 pb-4',
            )}
            data-testid="chat-suggestions"
          >
            {suggestions.map((s, index) => (
              <Button
                key={s}
                size="sm"
                variant={layout === 'dock' ? 'ghost' : 'secondary'}
                shape={layout === 'dock' ? 'rounded' : undefined}
                className={
                  layout === 'dock'
                    ? 'shrink-0'
                    : 'h-auto min-h-8 max-w-full text-start whitespace-normal'
                }
                disabled={busy || undefined}
                onClick={() => ask(s)}
              >
                {layout === 'dock' ? (RECIPE_LABELS[index] ?? s) : s}
              </Button>
            ))}
          </div>
        )}
        {layout === 'dock' && (
          <div className="flex shrink-0 items-end gap-2 px-2 pb-2">
            <DockControlsOutlet panel="assistant" />
            <Composer
              compact
              busy={busy}
              placeholder={placeholder}
              autoFocus={autoFocus}
              onSend={ask}
              onStop={() => void stop()}
            />
          </div>
        )}
      </div>
    </ChatSessionContext.Provider>
  );
}

function MessageList({
  messages,
  answerActions,
  busy,
  lastId,
  children,
}: {
  messages: ChatUIMessage[];
  answerActions: boolean;
  busy: boolean;
  lastId: string | undefined;
  children: React.ReactNode;
}) {
  // Each answer's question (for a stale proposal's "Re-run").
  const questions = new Map<string, string>();
  let question: string | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      question = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    } else if (question !== undefined) {
      questions.set(message.id, question);
    }
  }
  // Follows the stream while the reader is at the end; leaves them alone once they scroll up.
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport aria-label="Conversation" data-testid="chat-messages">
          <MessageScrollerContent className="gap-5 px-4 py-5">
            {messages.map((message) => {
              if (message.role !== 'user' && message.role !== 'assistant') return null;
              return (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === 'user'}
                >
                  {message.role === 'user' ? (
                    <UserMessage message={message} />
                  ) : (
                    <AssistantMessage
                      message={message}
                      question={questions.get(message.id)}
                      streaming={busy && message.id === lastId}
                      actions={answerActions}
                    />
                  )}
                </MessageScrollerItem>
              );
            })}
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function EmptyChat({
  title,
  description,
  layout,
}: {
  title: string;
  description: string;
  layout: 'page' | 'panel';
}) {
  const { user } = useFeatureUi();
  const name = user.name?.trim();
  const firstName = name && !name.includes('@') ? name.split(/\s+/)[0] : 'there';
  return (
    <section
      className="flex shrink-0 flex-col items-center gap-2 px-4 pb-5 text-center"
      data-testid="chat-empty"
    >
      <h2
        className={cn(
          'max-w-full text-gray-1000',
          layout === 'panel' ? 'truncate text-heading-24' : 'text-heading-32',
        )}
      >
        Hello, {firstName}
      </h2>
      <p className="text-copy-16 text-gray-1000">{title}</p>
      <p className="text-copy-14 text-gray-900">{description}</p>
    </section>
  );
}

function Composer({
  busy,
  compact,
  placeholder,
  autoFocus,
  onSend,
  onStop,
}: {
  busy: boolean;
  compact?: boolean;
  placeholder: string;
  autoFocus?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState('');
  const send = () => {
    if (busy || !value.trim()) return;
    onSend(value);
    setValue('');
  };
  return (
    <form
      className={compact ? 'min-w-0 flex-1' : 'p-3 pt-0'}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <InputGroup
        variant="secondary"
        size={compact ? 'lg' : undefined}
        className={compact ? 'min-h-10 rounded-full' : undefined}
      >
        <InputGroupTextarea
          aria-label="Ask the assistant"
          data-testid="chat-input"
          value={value}
          rows={compact ? 1 : 2}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          className={cn(
            'max-h-60 [field-sizing:content]',
            compact ? 'min-h-0 data-[size=lg]:py-1.5' : 'min-h-16',
          )}
        />
        <InputGroupAddon
          align={compact ? 'inline-end' : 'block-end'}
          className={compact ? 'py-0' : undefined}
        >
          {!compact && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear message"
                title="Clear message"
                disabled={!value}
                onClick={() => setValue('')}
              >
                <IconX />
              </Button>
              <span className="flex flex-1 items-center gap-1.5 text-label-12 text-gray-900">
                <IconCornerDownLeft className="size-3.5 shrink-0" /> Shift + Enter for a new line
              </span>
            </>
          )}
          {busy ? (
            <Button
              type="button"
              size="icon-sm"
              shape={compact ? 'rounded' : undefined}
              variant="secondary"
              aria-label="Stop"
              data-testid="chat-stop"
              onClick={onStop}
            >
              <IconPlayerStopFilled />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              shape={compact ? 'rounded' : undefined}
              aria-label="Send"
              disabled={!value.trim()}
            >
              <IconArrowUp />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
