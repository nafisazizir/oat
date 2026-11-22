// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode, ComponentProps } from 'react';
import type { OpenDocumentHandle } from '@oat/feature-ui/assistant';
import { AssistantPageEditor } from './page-assistant';

type DocumentDetail = ComponentProps<typeof AssistantPageEditor>['document'];

const model = vi.hoisted(() => ({
  register: vi.fn(),
  panel: vi.fn(),
  settle: vi.fn(),
  adopt: vi.fn(),
  setContent: vi.fn(),
  setUpdatedAt: vi.fn(),
}));
vi.mock('@oat/feature-ui/assistant', () => ({
  useRegisterOpenDocument: model.register,
  DocumentAssistant: ({ children, ...props }: { children: ReactNode }) => {
    model.panel(props);
    return children;
  },
}));
vi.mock('@oat/workspace-ui/page-editor', () => ({
  PageEditor: ({ children }: { children: ReactNode }) => children,
  PageEditorSurface: () => <p>Page editor</p>,
  usePageEditor: () => ({
    doc: { id: 'page' },
    autosave: { settle: model.settle, adopt: model.adopt },
    editorRef: { current: null },
    setContent: model.setContent,
    setUpdatedAt: model.setUpdatedAt,
  }),
}));
beforeEach(() => vi.clearAllMocks());
it('hosts the shared panel and flushes/adopts through the existing page editor bridge', async () => {
  render(
    <AssistantPageEditor
      document={{ id: 'page', workspaceId: 'w', deletedAt: null } as DocumentDetail}
      workspace={{ name: 'Team' }}
    />,
  );
  expect(model.panel).toHaveBeenCalledWith(
    expect.objectContaining({ documentId: 'page', workspaceId: 'w', available: true }),
  );
  const handle = model.register.mock.calls[0]![1] as OpenDocumentHandle;
  expect(handle.editor()).toBeNull();
  await handle.settle();
  expect(model.settle).toHaveBeenCalledOnce();
  const doc = { version: 3, contentJson: { type: 'doc', content: [] } };
  handle.adopt(doc);
  expect(model.adopt).toHaveBeenCalledWith(doc);
  handle.replace(doc);
  expect(model.setContent).toHaveBeenCalledWith(doc.contentJson);
});
it('disables the assistant for trashed pages', () => {
  render(
    <AssistantPageEditor
      document={{ id: 'page', workspaceId: 'w', deletedAt: '2026-01-01' } as DocumentDetail}
      workspace={{ name: 'Team' }}
    />,
  );
  expect(model.panel).toHaveBeenCalledWith(expect.objectContaining({ available: false }));
});
