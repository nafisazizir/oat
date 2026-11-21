// @vitest-environment jsdom
import type { DesktopWorkspace } from '@oat/core/bridge';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function view(
  workspaces: DesktopWorkspace[],
  activeId: string | null,
  targetId: string | null,
  synced = true,
) {
  const snapshot = { workspaces, activeId, targetId, synced };
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
  // The opened menu (shell.test.tsx stubs the same).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
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

  it('synced and in no workspace at all: asks me to create one', () => {
    show(view([], null, null));
    expect(screen.getByTestId('workspace-hint').textContent).toBe(
      'You’re not in a workspace. Create one on the web to take notes.',
    );
  });

  it('not synced yet, or my role not known yet: says nothing', () => {
    show(view([], null, null, false));
    expect(screen.queryByTestId('workspace-hint')).toBeNull();
    cleanup();
    show(view([ws('old', 'Old', null)], 'old', null));
    expect(screen.queryByTestId('workspace-hint')).toBeNull();
  });
});

describe('WorkspaceSwitcher: nothing to switch between with one workspace (D-36)', () => {
  const mine = ws('mine', 'Ada’s workspace', 'owner');
  const board = ws('board', 'Board', 'member');

  it('with one workspace the menu has no workspace list and no selector', async () => {
    show(view([mine], 'mine', 'mine'));
    const trigger = screen.getByTestId('workspace-switcher');
    expect(trigger.getAttribute('data-switchable')).toBe('false');
    // Still says where I am.
    expect(trigger.textContent).toContain('Ada’s workspace');
    await userEvent.click(trigger);
    expect(await screen.findByText('Workspace settings (web)')).toBeTruthy();
    expect(screen.queryByTestId('workspace-list')).toBeNull();
    expect(screen.queryAllByTestId('workspace-option')).toHaveLength(0);
  });

  it('with two it lists them', async () => {
    show(view([board, mine], 'mine', 'mine'));
    const trigger = screen.getByTestId('workspace-switcher');
    expect(trigger.getAttribute('data-switchable')).toBe('true');
    await userEvent.click(trigger);
    expect(await screen.findByTestId('workspace-list')).toBeTruthy();
    expect(screen.getAllByTestId('workspace-option')).toHaveLength(2);
  });
});
