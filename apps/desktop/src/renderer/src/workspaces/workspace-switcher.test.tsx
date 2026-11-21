// @vitest-environment jsdom
import type { DesktopWorkspace } from '@oat/core/bridge';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSwitcher } from './workspace-switcher.tsx';
import { activeAndFallback, type WorkspacesView } from './workspaces-state.ts';

vi.mock('../bridge.ts', () => ({
  BridgeCallError: class BridgeCallError extends Error {},
  call: vi.fn(),
}));

const ws = (id: string, name: string, role: DesktopWorkspace['role']): DesktopWorkspace => ({
  id,
  name,
  role,
  canCreate: role !== null && role !== 'viewer',
});

function view(workspaces: DesktopWorkspace[], activeId: string, targetId: string | null) {
  const snapshot = { workspaces, activeId, targetId };
  return { snapshot, ...activeAndFallback(snapshot), setActive: vi.fn() } satisfies WorkspacesView;
}

const show = (v: WorkspacesView) =>
  render(
    <SidebarProvider>
      <WorkspaceSwitcher view={v} account={null} label="Ada" email="ada@example.test" />
    </SidebarProvider>,
  );

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceSwitcher hint (where new notes go)', () => {
  const board = ws('board', 'Board', 'viewer');
  const mine = ws('mine', 'Ada’s workspace', 'owner');

  it('says nothing when new notes go to the active workspace', () => {
    show(view([board, mine], 'mine', 'mine'));
    expect(screen.queryByTestId('workspace-hint')).toBeNull();
    // Every workspace is labelled by my role in it; none is special (D-36).
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('Ada’s workspace');
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('Owner');
  });

  it('as a viewer, names the workspace new notes go to instead', () => {
    show(view([board, mine], 'board', 'mine'));
    expect(screen.getByTestId('workspace-hint').textContent).toBe(
      'You can view Board but not add notes to it. New notes go to Ada’s workspace.',
    );
  });

  it('with nowhere to add notes, asks me to create a workspace', () => {
    show(view([board], 'board', null));
    expect(screen.getByTestId('workspace-hint').textContent).toBe(
      'You can view Board but not add notes to it. Create a workspace of your own on the web to take notes.',
    );
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('View only');
  });
});
