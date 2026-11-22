// @vitest-environment jsdom
import { createOatClient } from '@oat/client';
import type { ChatUIMessage } from '@oat/services/dto/chat';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatSession } from './chat-session';
import { FeatureUiProvider, type FeatureUiAdapter } from './provider';

const model = vi.hoisted(() => ({
  status: 'streaming' as 'streaming' | 'ready',
  finish: null as
    | null
    | ((event: {
        message: { id: string; metadata: { threadId: string } };
        isAbort: boolean;
        isError: boolean;
      }) => void),
  setMessages: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  clearError: vi.fn(),
}));
vi.mock('@ai-sdk/react', () => ({
  useChat: (options: { onFinish: typeof model.finish }) => {
    model.finish = options.onFinish;
    return {
      messages: [],
      status: model.status,
      error: undefined,
      setMessages: model.setMessages,
      stop: model.stop,
      sendMessage: model.sendMessage,
      clearError: model.clearError,
    };
  },
}));
const messages: ChatUIMessage[] = [
  {
    id: 'answer',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Saved answer' }],
    metadata: {
      threadId: 'thread',
      proposals: [
        {
          id: 'proposal',
          documentId: 'doc',
          baseVersion: 1,
          summary: 'Change',
          changes: [],
          status: 'pending',
        },
      ],
    },
  },
];
function setup() {
  const transport = vi.fn(async () => ({
    status: 200,
    json: async () => ({ id: 'thread', messages, sources: { citations: {}, documents: {} } }),
  }));
  const value: FeatureUiAdapter = {
    client: createOatClient(transport),
    transport,
    navigate: vi.fn(),
    notify: { success: vi.fn(), error: vi.fn() },
    workspaceId: 'workspace',
    user: { id: 'user', name: 'Alex', email: 'alex@example.test' },
    searchSources: [],
  };
  const ui = () => (
    <FeatureUiProvider value={value}>
      <ChatSession
        scope={{ kind: 'document', documentId: 'doc' }}
        threadId="thread"
        placeholder="Ask"
        suggestions={[]}
        emptyTitle="Ask about this note"
        emptyDescription="Answers cite notes."
      />
    </FeatureUiProvider>
  );
  return { ...render(ui()), ui, transport };
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  model.status = 'streaming';
});
const finish = () =>
  model.finish!({
    message: { id: 'answer', metadata: { threadId: 'thread' } },
    isAbort: false,
    isError: false,
  });
it('waits for committed ready state before reading and adopting persisted proposal metadata', async () => {
  const view = setup();
  await act(async () => finish());
  expect(view.transport).not.toHaveBeenCalled();
  model.status = 'ready';
  view.rerender(view.ui());
  await waitFor(() => expect(model.setMessages).toHaveBeenCalledWith(messages));
  expect(view.transport).toHaveBeenCalledOnce();
});
it('ignores a late stream completion after the session unmounts', async () => {
  const view = setup();
  view.unmount();
  await act(async () => finish());
  expect(view.transport).not.toHaveBeenCalled();
});
