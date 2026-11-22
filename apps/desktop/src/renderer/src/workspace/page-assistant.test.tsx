// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode, ComponentProps } from 'react';
import type { DocumentEditorSurface } from '@oat/feature-ui/document';
import { AssistantPageEditor } from './page-assistant';

type DocumentDetail = ComponentProps<typeof AssistantPageEditor>['document'];
const model = vi.hoisted(() => ({
  panel: vi.fn(),
  surface: vi.fn(),
  call: vi.fn(),
  send: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('@oat/feature-ui/assistant', () => ({
  DocumentAssistant: ({ children, ...props }: { children: ReactNode }) => {
    model.panel(props);
    return children;
  },
}));
vi.mock('@oat/feature-ui/document', () => ({
  DocumentEditorSurface: (props: unknown) => {
    model.surface(props);
    return <p>Shared editor slots</p>;
  },
}));
vi.mock('@oat/workspace-ui/page-editor', () => ({
  PageEditor: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@oat/workspace-ui/host', () => ({
  useWorkspaceHost: () => ({ navigate: model.navigate }),
}));
vi.mock('../bridge', () => ({ call: model.call, bridge: () => ({ send: model.send }) }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
it('hosts shared page assistant/editor slots with native sync, integrations and external-open adapters', async () => {
  render(
    <AssistantPageEditor
      document={{ id: 'page', workspaceId: 'w', deletedAt: null } as DocumentDetail}
      workspace={{ name: 'Team' }}
    />,
  );
  expect(model.panel).toHaveBeenCalledWith(
    expect.objectContaining({ documentId: 'page', workspaceId: 'w', available: true }),
  );
  const slots = model.surface.mock.calls[0]![0] as ComponentProps<typeof DocumentEditorSurface>;
  await slots.beforeNetwork!();
  expect(model.call).toHaveBeenCalledWith('sync:now');
  slots.onOpenIntegrations();
  expect(model.navigate).toHaveBeenCalledWith({ view: 'settings', section: 'integrations' });
  slots.openExternal!('https://notion.so/n');
  expect(model.send).toHaveBeenCalledWith('shell:open-external', { url: 'https://notion.so/n' });
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
