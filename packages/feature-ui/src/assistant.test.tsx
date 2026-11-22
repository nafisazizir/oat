// @vitest-environment jsdom
import { createOatClient, OatApiError, type OatRequest, type OatResponse } from '@oat/client';
import type {
  ChatProposal,
  ChatSources,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatUIMessage,
} from '@oat/services/dto/chat';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantChat } from './assistant-chat';
import { ChatSession } from './chat-session';
import { AssistantIntegrationProvider, type AssistantIntegration } from './assistant-integration';
import { FeatureUiProvider, type FeatureUiAdapter, type LinkComponent } from './provider';

const scope = { kind: 'workspace', workspaceId: 'w' } as const;
const thread: ChatThreadSummary = {
  id: 'th1',
  workspaceId: 'w',
  scope: 'document',
  documentId: 'd1',
  title: 'Planning chat',
  createdAt: '2026-11-21T00:00:00Z',
  updatedAt: '2026-11-21T00:00:00Z',
};
const proposal: ChatProposal = {
  id: 'p1',
  documentId: 'd1',
  baseVersion: 3,
  summary: 'Clarify the plan',
  changes: [{ blockId: 'b1', before: 'Old plan', after: 'New plan' }],
  status: 'pending',
};
const sources: ChatSources = {
  documents: { d1: { title: 'Planning note' } },
  citations: {
    'block:b1': {
      kind: 'block',
      id: 'b1',
      documentId: 'd1',
      title: 'Planning note',
      text: 'The plan',
    },
    'seg:s1': {
      kind: 'seg',
      id: 's1',
      documentId: 'd1',
      title: 'Planning note',
      text: 'We agreed',
      speaker: 'Alex',
      startMs: 65000,
    },
  },
};
const messages: ChatUIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is the plan?' }] },
  {
    id: 'a1',
    role: 'assistant',
    metadata: { threadId: 'th1', proposals: [proposal] },
    parts: [{ type: 'text', text: '**The plan** [[block:b1]] and the discussion [[seg:s1]].' }],
  },
];
const detail = (status: ChatProposal['status'] = 'pending'): ChatThreadDetail => ({
  thread,
  messages: messages.map((message) => ({
    ...message,
    ...(message.metadata
      ? { metadata: { ...message.metadata, proposals: [{ ...proposal, status }] } }
      : {}),
    createdAt: thread.createdAt,
  })),
  sources,
});
const json = (value: unknown, status = 200): OatResponse => ({ status, json: async () => value });
function setup(
  handler: (request: OatRequest) => Promise<OatResponse> = async (request) =>
    json(request.path === '/api/chat/threads' ? { threads: [thread] } : detail()),
  integration?: AssistantIntegration,
) {
  const transport = vi.fn(handler);
  const value: FeatureUiAdapter = {
    client: createOatClient(transport),
    transport,
    navigate: vi.fn(),
    notify: { success: vi.fn(), error: vi.fn() },
    workspaceId: 'w',
    user: { id: 'u', name: 'Alex', email: 'alex@example.test' },
    searchSources: [],
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <FeatureUiProvider value={value}>
        <AssistantIntegrationProvider value={integration ?? {}}>
          {children}
        </AssistantIntegrationProvider>
      </FeatureUiProvider>
    );
  }
  return { transport, value, wrapper: Wrapper };
}
const sessionProps = {
  scope,
  threadId: null,
  placeholder: 'Ask…',
  suggestions: ['Summarize my notes'],
  emptyTitle: 'Ask across your meetings',
  emptyDescription: 'Answers cite your notes.',
};
async function send(text = 'Hello') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask the assistant' }), {
    target: { value: text },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const push = (data: unknown) =>
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  return {
    response(signal?: AbortSignal): OatResponse {
      signal?.addEventListener(
        'abort',
        () => {
          if (!closed) {
            closed = true;
            controller.error(new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true },
      );
      return {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-vercel-ai-ui-message-stream': 'v1',
          'x-oat-thread-id': 'th1',
        },
        body,
        json: async () => null,
      };
    },
    start(messageMetadata?: { threadId: string }) {
      push({
        type: 'start',
        messageId: 'stream-a',
        ...(messageMetadata ? { messageMetadata } : {}),
      });
      push({ type: 'text-start', id: 'text-1' });
    },
    text(delta: string) {
      push({ type: 'text-delta', id: 'text-1', delta });
    },
    finish() {
      push({ type: 'text-end', id: 'text-1' });
      push({ type: 'finish' });
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      closed = true;
      controller.close();
    },
  };
}

describe('AssistantChat', () => {
  it('keeps the composer mounted when leaving the centered new-chat state', async () => {
    const current = stream();
    const env = setup(async (request) => current.response(request.signal));
    render(<ChatSession {...sessionProps} />, env);
    const input = screen.getByTestId('chat-input');
    expect(screen.getByTestId('chat-session').getAttribute('data-empty')).toBe('true');
    expect(screen.getByText('Hello, Alex')).toBeTruthy();
    expect(screen.getByTestId('chat-suggestions')).toBeTruthy();
    await send();
    expect(screen.queryByTestId('chat-empty')).toBeNull();
    expect(screen.getByTestId('chat-session').getAttribute('data-empty')).toBe('false');
    expect(screen.getByTestId('chat-input')).toBe(input);
  });

  it('renders titled citation chips and a deduplicated source-note footer', async () => {
    const env = setup();
    render(
      <ChatSession
        {...sessionProps}
        threadId="th1"
        initialMessages={messages}
        initialSources={sources}
      />,
      env,
    );
    const citation = screen.getByRole('button', { name: 'Source 1: Planning note' });
    expect(citation.getAttribute('title')).toBe('Planning note');
    expect(
      screen.getAllByRole('button', { name: /^Open source note\s*1 Planning note$/ }),
    ).toHaveLength(1);
    await userEvent.click(
      screen.getByRole('button', { name: /^Open source note\s*1 Planning note$/ }),
    );
    expect(env.value.navigate).toHaveBeenCalledWith({ kind: 'document', id: 'd1', blockId: 'b1' });
  });

  it('omits the source-note footer when saved citations are unavailable', () => {
    const env = setup();
    render(<ChatSession {...sessionProps} threadId="th1" initialMessages={messages} />, env);
    expect(screen.queryByTestId('answer-sources')).toBeNull();
    expect(screen.getAllByTestId('citation-chip')[0]?.getAttribute('data-state')).toBe(
      'unavailable',
    );
  });

  it('renders threads, loads messages and sources, and follows the selected thread scope', async () => {
    const env = setup();
    const onThreadChange = vi.fn();
    render(
      <AssistantChat scope={scope} workspaceId="w" layout="page" onThreadChange={onThreadChange} />,
      env,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Planning chat/ }));
    expect(await screen.findByText('The plan', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByTestId('note-thread-banner')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Source 2: Planning note · 1:05 · Alex/ }),
    ).toBeTruthy();
    expect(onThreadChange).toHaveBeenCalledWith('th1');
    expect(env.transport).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/chat/threads', query: { workspaceId: 'w' } }),
    );
    expect(env.transport).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/chat/threads/th1' }),
    );
  });

  it('loads a URL-controlled initial thread and resets on external selection changes', async () => {
    const env = setup();
    const { rerender } = render(
      <AssistantChat scope={scope} workspaceId="w" layout="page" selectedThreadId="th1" />,
      env,
    );
    await screen.findByTestId('chat-answer');
    rerender(<AssistantChat scope={scope} workspaceId="w" layout="page" selectedThreadId={null} />);
    expect(await screen.findByText('Ask across your meetings')).toBeTruthy();
    expect(screen.queryByTestId('chat-answer')).toBeNull();
  });

  it('filters panel history to its note and supports new chat', async () => {
    const env = setup();
    render(
      <AssistantChat
        scope={{ kind: 'document', documentId: 'd1' }}
        workspaceId="w"
        layout="panel"
      />,
      env,
    );
    expect(await screen.findByText('Ask about this note')).toBeTruthy();
    expect(env.transport).toHaveBeenCalledWith(
      expect.objectContaining({ query: { workspaceId: 'w', documentId: 'd1' } }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByText('Ask about this note')).toBeTruthy();
  });

  it('shows empty history and retries a failed/offline thread list', async () => {
    let calls = 0;
    render(
      <AssistantChat scope={scope} workspaceId="w" layout="page" />,
      setup(async () => {
        if (++calls === 1) throw new OatApiError(0, 'unavailable', 'Disconnected');
        return json({ threads: [] });
      }),
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('offline'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
  });

  it('shows missing conversation errors and permits starting again', async () => {
    render(
      <AssistantChat scope={scope} workspaceId="w" layout="page" selectedThreadId="gone" />,
      setup(async (request) =>
        json(
          request.path === '/api/chat/threads'
            ? { threads: [] }
            : { error: { code: 'not_found', message: 'Missing' } },
          request.path === '/api/chat/threads' ? 200 : 404,
        ),
      ),
    );
    expect(await screen.findByText('This conversation is no longer available.')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0]!);
    expect(await screen.findByText('Ask across your meetings')).toBeTruthy();
  });
});

describe('ChatSession transport and navigation', () => {
  it('streams a real AI SDK SSE reply and carries the returned thread id to follow-ups', async () => {
    let current = stream();
    const env = setup(async (request) => current.response(request.signal));
    render(<ChatSession {...sessionProps} />, env);
    expect(screen.getByText('Ask across your meetings')).toBeTruthy();
    await send();
    await act(async () => {
      current.start();
      current.text('Hello from ');
    });
    expect(await screen.findByText('Hello from')).toBeTruthy();
    await act(async () => {
      current.text('the assistant');
      current.finish();
    });
    expect(await screen.findByText('Hello from the assistant')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('chat-session').getAttribute('data-status')).toBe('ready'),
    );
    expect(env.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/chat',
        method: 'POST',
        stream: true,
        body: expect.objectContaining({
          scope,
          messages: [
            expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
          ],
        }),
      }),
    );
    current = stream();
    await send('Follow up');
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ threadId: 'th1' }) }),
    );
    await act(async () => {
      current.start();
      current.text('Second answer');
      current.finish();
    });
    expect(await screen.findByText('Second answer')).toBeTruthy();
  });

  it('resolves saved sources without remounting a new session when its URL selection updates', async () => {
    const current = stream();
    const env = setup(async (request) => {
      if (request.path === '/api/chat') return current.response(request.signal);
      if (request.path === '/api/chat/threads') return json({ threads: [thread] });
      return json({
        ...detail(),
        messages: [
          {
            id: 'stream-a',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Saved [[block:b1]]' }],
            metadata: { threadId: 'th1' },
          },
        ],
      });
    });
    function Host() {
      const [id, setId] = useState<string | null>(null);
      return (
        <AssistantChat
          scope={scope}
          workspaceId="w"
          layout="page"
          selectedThreadId={id}
          onThreadChange={setId}
        />
      );
    }
    render(<Host />, env);
    await send();
    await act(async () => {
      current.start({ threadId: 'th1' });
      current.text('Saved [[block:b1]]');
    });
    expect((await screen.findByTestId('citation-chip')).getAttribute('data-state')).toBe('pending');
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask the assistant' }), {
      target: { value: 'Next question' },
    });
    await act(async () => current.finish());
    expect(await screen.findByRole('button', { name: 'Source 1: Planning note' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement).value,
    ).toBe('Next question');
  });

  it('aborts the in-flight stream at the host transport on unmount', async () => {
    const current = stream();
    const env = setup(async (request) => current.response(request.signal));
    const { unmount } = render(<ChatSession {...sessionProps} />, env);
    await send();
    await act(async () => {
      current.start();
      current.text('Still answering');
    });
    await screen.findByText('Still answering');
    const signal = env.transport.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('aborts a stream when switching to another thread', async () => {
    const current = stream();
    const env = setup(async (request) =>
      request.path === '/api/chat'
        ? current.response(request.signal)
        : json(request.path === '/api/chat/threads' ? { threads: [thread] } : detail()),
    );
    render(<AssistantChat scope={scope} workspaceId="w" layout="page" />, env);
    await screen.findByRole('button', { name: /Planning chat/ });
    await send();
    const signal = env.transport.mock.calls.find(([request]) => request.path === '/api/chat')?.[0]
      .signal;
    await userEvent.click(screen.getByRole('button', { name: /Planning chat/ }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByTestId('proposal-card')).toBeTruthy();
  });

  it('stops from the composer button', async () => {
    const current = stream();
    const env = setup(async (request) => current.response(request.signal));
    render(<ChatSession {...sessionProps} />, env);
    await send();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(env.transport.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it('navigates citations to document block and segment/time AppTargets', async () => {
    const env = setup();
    render(
      <ChatSession
        {...sessionProps}
        threadId="th1"
        initialMessages={messages}
        initialSources={sources}
      />,
      env,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Source 1: Planning note' }));
    expect(env.value.navigate).toHaveBeenLastCalledWith({
      kind: 'document',
      id: 'd1',
      blockId: 'b1',
    });
    await userEvent.click(screen.getByRole('button', { name: /Source 2:/ }));
    expect(env.value.navigate).toHaveBeenLastCalledWith({
      kind: 'document',
      id: 'd1',
      segmentId: 's1',
      timeMs: 65000,
    });
  });

  it('allows the web bridge to handle open-note citations in place', async () => {
    const integration = { openCitation: vi.fn(() => true) };
    const env = setup(undefined, integration);
    render(
      <ChatSession {...sessionProps} initialMessages={messages} initialSources={sources} />,
      env,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Source 1: Planning note' }));
    expect(integration.openCitation).toHaveBeenCalledWith(sources.citations['block:b1']);
    expect(env.value.navigate).not.toHaveBeenCalled();
  });

  it('uses host links for document links and sanitizes model markdown', async () => {
    const env = setup();
    const Link: LinkComponent = (props) => <a {...props} data-host-link />;
    env.value.Link = Link;
    env.value.hrefFor = (target) => (target.kind === 'document' ? `/note/${target.id}` : '/');
    render(
      <ChatSession
        {...sessionProps}
        initialMessages={[
          {
            id: 'a',
            role: 'assistant',
            parts: [
              {
                type: 'text',
                text: '[Open note](/d/d1?block=b1) <script>bad()</script> [unsafe](javascript:alert(1))',
              },
            ],
          },
        ]}
      />,
      env,
    );
    const link = screen.getByRole('link', { name: 'Open note' });
    expect(link.getAttribute('href')).toBe('/note/d1');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it.each([
    ['offline', 0, 'unavailable', 'Disconnected'],
    ['error', 500, 'internal_error', 'Try again later'],
    ['rate_limited', 429, 'rate_limited', 'Slow down'],
  ])('describes %s send failures', async (kind, status, code, message) => {
    render(
      <ChatSession {...sessionProps} />,
      setup(async () => {
        if (status === 0) throw new OatApiError(status, code, message);
        return json({ error: { code, message } }, status);
      }),
    );
    await send();
    expect((await screen.findByTestId('chat-error')).getAttribute('data-kind')).toBe(kind);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('proposal decisions', () => {
  it.each(['approve', 'reject'] as const)(
    'sends %s and refreshes the persisted proposal',
    async (decision) => {
      let status: ChatProposal['status'] = 'pending';
      const env = setup(async (request) => {
        if (request.method === 'POST') {
          status = decision === 'approve' ? 'applied' : 'rejected';
          return json({
            proposal: { ...proposal, status },
            ...(decision === 'approve' ? { document: { id: 'd1', version: 4 } } : {}),
          });
        }
        return json(detail(status));
      });
      render(
        <ChatSession
          {...sessionProps}
          threadId="th1"
          initialMessages={messages}
          initialSources={sources}
        />,
        env,
      );
      await userEvent.click(
        screen.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Reject' }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('proposal-card').getAttribute('data-status')).toBe(status),
      );
      expect(env.transport).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/chat/threads/th1/proposals/p1',
          body: { decision },
        }),
      );
      if (decision === 'approve')
        expect(env.value.notify.success).toHaveBeenCalledWith(
          'Change applied',
          expect.objectContaining({ description: 'Planning note' }),
        );
    },
  );

  it('lets the editor bridge settle, apply and release around approval', async () => {
    const application = { applied: vi.fn(async () => {}), release: vi.fn() };
    const prepareProposal = vi.fn(async () => application);
    const env = setup(
      async (request) =>
        json(
          request.method === 'POST'
            ? { proposal: { ...proposal, status: 'applied' }, document: { id: 'd1', version: 4 } }
            : detail('applied'),
        ),
      { prepareProposal },
    );
    render(
      <ChatSession
        {...sessionProps}
        threadId="th1"
        initialMessages={messages}
        initialSources={sources}
      />,
      env,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(application.release).toHaveBeenCalledOnce());
    expect(prepareProposal).toHaveBeenCalledWith(proposal);
    expect(application.applied).toHaveBeenCalledWith(
      expect.objectContaining({ document: { id: 'd1', version: 4 } }),
    );
    expect(env.value.notify.success).toHaveBeenCalledWith('Change applied to this note');
  });

  it('keeps unsaved editor edits safe when preparation refuses approval', async () => {
    const env = setup(undefined, {
      prepareProposal: async () => {
        throw new Error('Your latest edits aren’t saved yet.');
      },
    });
    render(
      <ChatSession
        {...sessionProps}
        threadId="th1"
        initialMessages={messages}
        initialSources={sources}
      />,
      env,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Your latest edits aren’t saved yet.',
    );
    expect(env.transport.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

  it('reports a failed decision, releases the bridge, and restores controls', async () => {
    const release = vi.fn();
    const env = setup(
      async (request) =>
        request.method === 'POST'
          ? json({ error: { code: 'forbidden', message: 'Read only' } }, 403)
          : json(detail()),
      { prepareProposal: async () => ({ applied: vi.fn(), release }) },
    );
    render(
      <ChatSession
        {...sessionProps}
        threadId="th1"
        initialMessages={messages}
        initialSources={sources}
      />,
      env,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Read only')).toBeTruthy();
    expect(release).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false),
    );
  });
});
