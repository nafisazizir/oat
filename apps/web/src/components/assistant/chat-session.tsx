'use client';

import { useChat } from '@ai-sdk/react';
import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import { DefaultChatTransport } from 'ai';
import { AlertCircleIcon, ArrowUpIcon, Loader2Icon, SquareIcon } from 'lucide-react';
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
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              Thinking…
            </p>
          )}
          {failure && (
            <div
              role="alert"
              data-testid="chat-error"
              data-kind={failure.kind}
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
            >
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="flex-1">{failure.message}</span>
            </div>
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
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
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
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      data-testid="chat-messages"
      role="region"
      aria-label="Conversation"
    >
      {messages.map((message) => {
        if (message.role === 'user') {
          return <UserMessage key={message.id} message={message} />;
        }
        if (message.role !== 'assistant') return null;
        return (
          <AssistantMessage
            key={message.id}
            message={message}
            question={questions.get(message.id)}
            streaming={busy && message.id === lastId}
          />
        );
      })}
      {children}
    </div>
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
    <div className="my-auto flex flex-col gap-4 py-6" data-testid="chat-empty">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-xl">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="w-full rounded-lg border bg-card px-3 py-2 text-left text-sm transition-colors duration-fast hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
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
      className="border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background px-3 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
        <textarea
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
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm [field-sizing:content] outline-none placeholder:text-muted-foreground"
        />
        {busy ? (
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            aria-label="Stop"
            data-testid="chat-stop"
            onClick={onStop}
          >
            <SquareIcon className="fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send"
            disabled={!value.trim()}
            className={cn(!value.trim() && 'opacity-40')}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </form>
  );
}
