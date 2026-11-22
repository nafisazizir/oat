// @vitest-environment jsdom
import { createOatClient } from '@oat/client';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { ChatProposal } from '@oat/services/dto/chat';
import { FeatureUiProvider, type FeatureUiAdapter } from './provider';
import { useAssistantIntegration } from './assistant-integration';
import {
  OpenDocumentContext,
  OpenDocumentAssistantIntegration,
  type OpenDocumentHandle,
  type NoteEditor,
} from './open-document';

const body = { type: 'doc', content: [] };
const proposal: ChatProposal = {
  id: 'p',
  documentId: 'd',
  baseVersion: 2,
  status: 'pending',
  summary: 'Edit',
  changes: [],
};
const result = {
  proposal: { ...proposal, status: 'applied' as const },
  document: { id: 'd', version: 3 },
};
function setup(local = false) {
  const edit = vi.fn();
  const apply = vi.fn(async () => {});
  const editor = { isEditable: true, setEditable: edit } as unknown as NoteEditor;
  const handle: OpenDocumentHandle = {
    settle: vi.fn(async () => true),
    adopt: vi.fn(),
    replace: vi.fn(),
    editor: () => (local ? editor : null),
    ...(local ? { prepareApply: vi.fn(() => apply) } : {}),
  };
  const transport = vi.fn(async () => ({
    status: 200,
    json: async () => ({ version: 3, contentJson: body }),
  }));
  const navigate = vi.fn();
  const showBlock = vi.fn();
  const host: FeatureUiAdapter = {
    client: createOatClient(transport),
    transport,
    navigate,
    notify: { success: vi.fn(), error: vi.fn() },
    workspaceId: 'w',
    user: { id: 'u', name: 'Alex', email: 'a@b.test' },
    searchSources: [],
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <FeatureUiProvider value={host}>
        <OpenDocumentContext
          value={{ documentId: 'd', register: vi.fn(), handle: () => handle, showBlock }}
        >
          <OpenDocumentAssistantIntegration>{children}</OpenDocumentAssistantIntegration>
        </OpenDocumentContext>
      </FeatureUiProvider>
    );
  }
  const hook = renderHook(useAssistantIntegration, { wrapper: Wrapper });
  return { integration: hook.result.current, handle, apply, transport, edit, showBlock, navigate };
}

it('settles the matching document only before sending and never applies a proposal by itself', async () => {
  const env = setup(true);
  await env.integration.beforeSend!({ kind: 'workspace', workspaceId: 'w' });
  await env.integration.beforeSend!({ kind: 'document', documentId: 'other' });
  expect(env.handle.settle).not.toHaveBeenCalled();
  await env.integration.beforeSend!({ kind: 'document', documentId: 'd' });
  expect(env.handle.settle).toHaveBeenCalledOnce();
  expect(env.apply).not.toHaveBeenCalled();
});
it('blocks sending and approval when edits cannot settle, and unlocks the editor', async () => {
  const env = setup(true);
  vi.mocked(env.handle.settle).mockResolvedValue(false);
  await expect(env.integration.beforeSend!({ kind: 'document', documentId: 'd' })).rejects.toThrow(
    'latest edits',
  );
  await expect(env.integration.prepareProposal!(proposal)).rejects.toThrow('latest edits');
  expect(env.edit.mock.calls).toEqual([
    [false, false],
    [true, false],
  ]);
  expect(env.transport).not.toHaveBeenCalled();
});
it('uses the native writer only after explicit approval, then releases editing', async () => {
  const env = setup(true);
  const application = await env.integration.prepareProposal!(proposal);
  expect(env.edit).toHaveBeenCalledWith(false, false);
  expect(env.handle.prepareApply).toHaveBeenCalledOnce();
  expect(env.apply).not.toHaveBeenCalled();
  env.handle.prepareApply = vi.fn(() => vi.fn(async () => {}));
  await application!.applied(result);
  expect(env.apply).toHaveBeenCalledWith({ version: 3, contentJson: body });
  expect(env.handle.adopt).not.toHaveBeenCalled();
  expect(env.handle.replace).not.toHaveBeenCalled();
  application!.release();
  expect(env.edit).toHaveBeenLastCalledWith(true, false);
});
it('keeps the existing web/page adopt-and-replace fallback', async () => {
  const env = setup();
  const application = await env.integration.prepareProposal!(proposal);
  await application!.applied(result);
  expect(env.handle.adopt).toHaveBeenCalledWith({ version: 3, contentJson: body });
  expect(env.handle.replace).toHaveBeenCalledWith({ version: 3, contentJson: body });
});
it('does not apply an unavailable or subsequently changed approved body', async () => {
  const env = setup(true);
  const application = await env.integration.prepareProposal!(proposal);
  env.transport.mockRejectedValueOnce(new Error('Offline'));
  await expect(application!.applied(result)).rejects.toThrow('reload');
  env.transport.mockResolvedValueOnce({
    status: 200,
    json: async () => ({ version: 4, contentJson: body }),
  });
  await expect(application!.applied(result)).rejects.toThrow('changed again');
  expect(env.apply).not.toHaveBeenCalled();
});
it('focuses blocks in place and dispatches transcript citations through the host', () => {
  const env = setup();
  expect(
    env.integration.openCitation!({
      kind: 'block',
      documentId: 'd',
      id: 'b',
      title: 'Note',
      text: '',
    }),
  ).toBe(true);
  expect(env.showBlock).toHaveBeenCalledWith('b');
  expect(
    env.integration.openCitation!({
      kind: 'seg',
      documentId: 'd',
      id: 's',
      title: 'Note',
      text: '',
      speaker: 'Alex',
      startMs: 1000,
    }),
  ).toBe(true);
  expect(env.navigate).toHaveBeenCalledWith({
    kind: 'document',
    id: 'd',
    segmentId: 's',
    timeMs: 1000,
  });
});
