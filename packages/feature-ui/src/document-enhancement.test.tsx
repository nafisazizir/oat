// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createOatClient, type OatClient, type OatRequest, type OatResponse } from '@oat/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnhancementDto } from '@oat/services/dto/enhance';
import { useDocumentEnhancement, type DocumentWriteAdapter } from './document-enhancement';
import { enhancementSource } from './enhance-client';

const model = vi.hoisted(() => ({
  client: {} as OatClient,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('./provider', () => ({ useFeatureUi: () => ({ client: model.client }) }));
vi.mock('sonner', () => ({ toast: model.toast }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
const original = { type: 'doc', content: [] };
const enhanced = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Enhanced' }] }],
};
const now = '2026-11-22T10:00:00Z';
const run: EnhancementDto = {
  id: 'r',
  documentId: 'd',
  templateId: null,
  status: 'completed',
  model: 'mock',
  startedAt: now,
  completedAt: now,
  applied: true,
  documentVersion: 3,
  error: null,
};
const json = (value: unknown, status = 200): OatResponse => ({ status, json: async () => value });
const stream = (frames: string): OatResponse => ({
  status: 200,
  json: async () => null,
  body: new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(frames));
      c.close();
    },
  }),
});
const event = (type: string, value: unknown, id = '1') =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(value)}\n\n`;

function setup(
  options: { applied?: boolean; settle?: boolean; edited?: boolean; missingHistory?: boolean } = {},
) {
  const apply = vi.fn(async () => {});
  const host: DocumentWriteAdapter = {
    settle: vi.fn(async () => options.settle !== false),
    currentVersion: () => 2,
    prepareApply: vi.fn(() => apply),
    useBody: vi.fn(async () => {}),
  };
  const handler = vi.fn(async (req: OatRequest): Promise<OatResponse> => {
    if (req.path.endsWith('/stream'))
      return stream(
        event('completed', {
          type: 'completed',
          enhancement: { ...run, applied: options.applied !== false },
          doc: enhanced,
        }),
      );
    if (req.path.endsWith('/restore'))
      return json({
        document: { version: 4, contentJson: original, updatedAt: now },
        snapshot: null,
      });
    if (req.path.endsWith('/enhancements'))
      return options.missingHistory
        ? json({ error: { code: 'not_found', message: 'Missing' } }, 404)
        : json({
            versions: [run],
            snapshots: [],
            body: { version: 2, edited: options.edited ?? false },
          });
    if (req.method === 'POST') return json({ enhancement: run, attached: false });
    return json({ latest: null });
  });
  model.client = createOatClient(handler);
  const rendered = renderHook(() =>
    useDocumentEnhancement({
      documentId: 'd',
      loadedVersion: 2,
      enabled: true,
      editable: true,
      host,
    }),
  );
  return { ...rendered, apply, host, handler };
}

it('settles, captures the writer before POST and applies the completed body before offering Undo', async () => {
  const env = setup();
  await act(() => env.result.current.enhancement.start());
  await waitFor(() =>
    expect(env.apply).toHaveBeenCalledWith({ version: 3, contentJson: enhanced, updatedAt: now }),
  );
  const post = env.handler.mock.calls.findIndex(([req]) => req.method === 'POST');
  expect(vi.mocked(env.host.settle).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(env.host.prepareApply).mock.invocationCallOrder[0]!,
  );
  expect(vi.mocked(env.host.prepareApply).mock.invocationCallOrder[0]).toBeLessThan(
    env.handler.mock.invocationCallOrder[post]!,
  );
  expect(model.toast.success).toHaveBeenCalledWith(
    'Notes enhanced',
    expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
  );
  expect(env.result.current.enhancement.state.phase).toBe('idle');
});
it.each([false, 'offline'])(
  'blocks enhancement before the request when preflight is %s',
  async (failure) => {
    const env = setup({ settle: false });
    if (failure === 'offline') vi.mocked(env.host.settle).mockRejectedValue(new Error('Offline'));
    await act(() => env.result.current.enhancement.start());
    expect(env.handler.mock.calls.some(([req]) => req.method === 'POST')).toBe(false);
    expect(env.result.current.enhancement.state.phase).toBe('failed');
    expect(env.apply).not.toHaveBeenCalled();
  },
);
it('keeps a concurrently edited note and only uses an unapplied enhanced body after the explicit toast action', async () => {
  const env = setup({ applied: false });
  await act(() => env.result.current.enhancement.start());
  await waitFor(() => expect(model.toast).toHaveBeenCalled());
  expect(env.apply).not.toHaveBeenCalled();
  expect(env.host.useBody).not.toHaveBeenCalled();
  const options = model.toast.mock.calls.at(-1)![1] as { action: { onClick(): void } };
  await act(() => options.action.onClick());
  expect(env.host.useBody).toHaveBeenCalledWith(enhanced);
});
it('awaits the captured restore writer and sends the current settled server version', async () => {
  const env = setup();
  await act(async () => expect(await env.result.current.versions.restore('r', 'notes')).toBe(true));
  expect(env.apply).toHaveBeenCalledWith({ version: 4, contentJson: original, updatedAt: now });
  expect(env.handler).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/api/enhancements/r/restore',
      body: { baseVersion: 2, target: 'notes' },
    }),
  );
});
it('reports local writer failure after a server restore rather than announcing success', async () => {
  const env = setup();
  env.apply.mockRejectedValue(new Error('Conflicted copies'));
  await act(async () =>
    expect(await env.result.current.versions.restore('r', 'output')).toBe(false),
  );
  expect(model.toast.error).toHaveBeenCalledWith(
    'Couldn’t restore',
    expect.objectContaining({ description: 'Conflicted copies' }),
  );
});
it('keeps the pre-request restore writer even when the host changes while the response is pending', async () => {
  const env = setup();
  await waitFor(() => expect(env.result.current.versions.list).not.toBeNull());
  let resolve!: (response: OatResponse) => void;
  const response = new Promise<OatResponse>((done) => {
    resolve = done;
  });
  env.handler.mockImplementationOnce(() => response);
  let restored!: Promise<boolean>;
  await act(async () => {
    restored = env.result.current.versions.restore('r', 'output');
  });
  const later = vi.fn(async () => {});
  vi.mocked(env.host.prepareApply).mockReturnValue(later);
  await act(async () => {
    resolve(
      json({ document: { version: 4, contentJson: enhanced, updatedAt: now }, snapshot: null }),
    );
    expect(await restored).toBe(true);
  });
  expect(env.apply).toHaveBeenCalledWith({ version: 4, contentJson: enhanced, updatedAt: now });
  expect(later).not.toHaveBeenCalled();
});
it('surfaces a completion adoption failure and never offers a misleading Undo success', async () => {
  const env = setup();
  env.apply.mockRejectedValue(new Error('This note changed again.'));
  await act(() => env.result.current.enhancement.start());
  await waitFor(() =>
    expect(env.result.current.enhancement.state).toMatchObject({
      phase: 'failed',
      message: 'This note changed again.',
    }),
  );
  expect(model.toast.success).not.toHaveBeenCalled();
});
it('guarded Undo requires confirmation for edited notes and can be cancelled without replacing anything', async () => {
  const env = setup({ edited: true });
  await act(() => env.result.current.versions.undo());
  await waitFor(() => expect(env.result.current.versions.pending?.kind).toBe('undo'));
  expect(env.apply).not.toHaveBeenCalled();
  act(() => env.result.current.versions.cancelPending());
  expect(env.result.current.versions.pending).toBeNull();
});
it('shows an unchecked confirmation if history is unavailable and keeps an empty history usable', async () => {
  const env = setup({ missingHistory: true });
  await act(() => env.result.current.versions.guard('restore', vi.fn()));
  expect(env.result.current.versions.list).toBeNull();
  expect(env.result.current.versions.pending?.unchecked).toBe(true);
});
it('streams through the declared client endpoint, resumes the cursor and aborts on close', async () => {
  const requests: OatRequest[] = [];
  const handler = vi.fn(async (request: OatRequest) => {
    requests.push(request);
    return requests.length === 1
      ? stream(event('preview', { type: 'preview', output: null }, 'p7'))
      : stream(event('completed', { type: 'completed', enhancement: run, doc: enhanced }, 'c8'));
  });
  const source = enhancementSource(createOatClient(handler), 'r');
  const done = new Promise<void>((resolve) =>
    source.addEventListener('completed', () => {
      source.close();
      resolve();
    }),
  );
  await done;
  expect(requests[0]).toMatchObject({ stream: true, path: '/api/enhancements/r/stream' });
  expect(requests[1]?.query).toEqual({ lastEventId: 'p7' });
  expect(requests[1]?.signal?.aborted).toBe(true);
});
it.each(['empty', 'invalid', 'forbidden'])(
  'surfaces %s streams through the error handler without leaking a connection',
  async (kind) => {
    const handler = vi.fn(async () =>
      kind === 'forbidden'
        ? json({ error: { code: 'forbidden', message: 'No access' } }, 403)
        : stream(kind === 'empty' ? '' : 'event: preview\ndata: not-json\n\n'),
    );
    const source = enhancementSource(createOatClient(handler), 'r');
    const error = vi.fn(() => source.close());
    source.onerror = error;
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(source.readyState).toBe(2);
    expect(handler).toHaveBeenCalledOnce();
  },
);
