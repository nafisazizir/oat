'use client';

import { useChat } from '@ai-sdk/react';
import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@oat/ui/components/empty';
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
import { IconAlertCircle, IconArrowUp, IconPlayerStopFilled } from '@tabler/icons-react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { chatApi, describeChatError } from '@/lib/chat-client';
import type { ChatScope, ChatSources, ChatUIMessage } from '@/lib/chat-types';

import { AssistantMessage, UserMessage } from './chat-message';
import { ChatSessionContext, type ChatSessionApi } from './session-context';

/** Mirrors the server's per-message limit (`CHAT_LIMITS.userChars`). */
const MAX_QUESTION_CHARS = 8000;
const EMPTY_SOURCES: ChatSources = { citations: {}, documents: {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where a session keeps its thread id: set from the first answer's response header. */
type ThreadHolder = { current: string | null };

/**
 * The AI SDK transport for one session. Only the new question goes out (the server loads the history from
 * the thread, D-27); the thread id comes back as a header before any token, so later turns continue it.
 */
function createTransport(scope: ChatScope, thread: ThreadHolder) {
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
  placeholder: string;
  suggestions: readonly string[];
  emptyTitle: string;
  emptyDescription: string;
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
  placeholder,
  suggestions,
  emptyTitle,
  emptyDescription,
  autoFocus,
}: ChatSessionProps) {
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

  const [transport] = useState(() => createTransport(scope, thread));

  const chat = useChat<ChatUIMessage>({
    transport,
    messages: initialMessages,
    onFinish: ({ message, isAbort, isError }) => {
      // One announcement per turn for screen readers (the streamed text itself is not a live region).
      setAnnouncement(isAbort ? 'Stopped.' : isError ? '' : 'Answer ready.');
      // The answer is saved when the server's stream ends; read it back (sources, proposal statuses).
      if (message.metadata?.threadId) void refreshRef.current(message.id);
    },
  });
  const { messages, status, error, sendMessage, stop, setMessages, clearError } = chat;
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });

  const refresh = useCallback(
    async (expectMessageId?: string) => {
      const id = thread.current;
      if (!id) return;
      for (let attempt = 0; attempt < 30; attempt++) {
        const detail = await chatApi.thread(id).catch(() => null);
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
        await sleep(Math.min(100 * (attempt + 1), 500));
      }
    },
    [setMessages, thread],
  );
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const busy = status === 'submitted' || status === 'streaming';
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
      <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-session" data-status={status}>
        <p role="status" className="sr-only" data-testid="chat-status">
          {announcement}
        </p>
        <MessageList messages={messages} busy={busy} lastId={last?.id}>
          {messages.length === 0 && (
            <EmptyChat
              title={emptyTitle}
              description={emptyDescription}
              suggestions={suggestions}
              onPick={ask}
            />
          )}
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
        <Composer
          busy={busy}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onSend={ask}
          onStop={() => void stop()}
        />
      </div>
    </ChatSessionContext.Provider>
  );
}

function MessageList({
  messages,
  busy,
  lastId,
  children,
}: {
  messages: ChatUIMessage[];
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
          <MessageScrollerContent className="gap-6 px-4 py-4">
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
  suggestions,
  onPick,
}: {
  title: string;
  description: string;
  suggestions: readonly string[];
  onPick: (text: string) => void;
}) {
  return (
    <Empty className="my-auto items-stretch p-0 text-start" data-testid="chat-empty">
      <EmptyHeader className="max-w-none items-start">
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none items-stretch gap-1">
        {suggestions.map((s) => (
          <Button
            key={s}
            variant="secondary"
            className="h-auto min-h-9 justify-start py-2 text-start whitespace-normal"
            onClick={() => onPick(s)}
          >
            {s}
          </Button>
        ))}
      </EmptyContent>
    </Empty>
  );
}

function Composer({
  busy,
  placeholder,
  autoFocus,
  onSend,
  onStop,
}: {
  busy: boolean;
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
      className="p-3 pt-0"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <InputGroup>
        <InputGroupTextarea
          aria-label="Ask the assistant"
          data-testid="chat-input"
          value={value}
          rows={1}
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
          className="max-h-40 min-h-10 [field-sizing:content]"
        />
        <InputGroupAddon align="inline-end" className="self-end pb-1.5">
          {busy ? (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              aria-label="Stop"
              data-testid="chat-stop"
              onClick={onStop}
            >
              <IconPlayerStopFilled />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" aria-label="Send" disabled={!value.trim()}>
              <IconArrowUp />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
