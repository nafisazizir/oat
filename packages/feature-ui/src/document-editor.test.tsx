// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import type { OpenDocumentHandle } from './open-document';
import { DocumentEditorSurface } from './document-editor';
import type { NotionExportButton } from './notion-export-button';
import type { PageEditorSurface } from '@oat/workspace-ui/page-editor';
const model = vi.hoisted(() => ({
  register: vi.fn(),
  surface: vi.fn(),
  notion: vi.fn(),
  assignees: vi.fn(),
  settle: vi.fn(),
  adopt: vi.fn(),
  setContent: vi.fn(),
  setUpdatedAt: vi.fn(),
}));
vi.mock('./open-document', () => ({ useRegisterOpenDocument: model.register }));
vi.mock('./tasks-client', () => ({ useTaskAssignees: () => model.assignees }));
vi.mock('./notion-export-button', () => ({
  NotionExportButton: (props: unknown) => {
    model.notion(props);
    return null;
  },
}));
vi.mock('./document-enhancement', () => ({
  useDocumentEnhancement: () => ({
    streaming: false,
    beforeEditor: null,
    enhance: () => null,
    historyAction: null,
    enhancement: { follow: vi.fn() },
  }),
}));
vi.mock('@oat/workspace-ui/page-editor', () => ({
  PageEditorSurface: (props: { renderSecondaryActions(lifecycle: ReactNode): ReactNode }) => {
    model.surface(props);
    return props.renderSecondaryActions(null);
  },
  MoreActions: ({ children }: { children: ReactNode }) => children,
  usePageEditor: () => ({
    doc: { id: 'd', kind: 'page', version: 2, workspaceId: 'w' },
    title: 'Page',
    editable: true,
    trashed: false,
    autosave: { settle: model.settle, adopt: model.adopt, queue: vi.fn(), currentVersion: () => 2 },
    editorRef: { current: null },
    setContent: model.setContent,
    setUpdatedAt: model.setUpdatedAt,
  }),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  model.settle.mockResolvedValue(true);
});
it('shares page assignee query and assistant settle/adopt/replace slots', async () => {
  const beforeNetwork = vi.fn(async () => {});
  render(<DocumentEditorSurface beforeNetwork={beforeNetwork} onOpenIntegrations={vi.fn()} />);
  const surface = model.surface.mock.calls.at(-1)![0] as ComponentProps<typeof PageEditorSurface>;
  expect(surface.taskAssignees).toBe(model.assignees);
  const handle = model.register.mock.calls.at(-1)![1] as OpenDocumentHandle;
  expect(handle.editor()).toBeNull();
  expect(await handle.settle()).toBe(true);
  expect(model.settle.mock.invocationCallOrder[0]).toBeLessThan(
    beforeNetwork.mock.invocationCallOrder[0]!,
  );
  const next = { version: 3, contentJson: { type: 'doc', content: [] } };
  handle.adopt(next);
  expect(model.adopt).toHaveBeenCalledWith(next);
  handle.replace(next);
  expect(model.setContent).toHaveBeenCalledWith(next.contentJson);
});
it('gives Notion the same preflight and refuses to sync after a failed save', async () => {
  const beforeNetwork = vi.fn(async () => {});
  model.settle.mockResolvedValue(false);
  render(<DocumentEditorSurface beforeNetwork={beforeNetwork} onOpenIntegrations={vi.fn()} />);
  const notion = model.notion.mock.calls.at(-1)![0] as ComponentProps<typeof NotionExportButton>;
  expect(await notion.beforeSend!()).toBe(false);
  expect(beforeNetwork).not.toHaveBeenCalled();
});
