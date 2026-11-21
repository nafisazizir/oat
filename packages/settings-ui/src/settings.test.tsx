// @vitest-environment jsdom
import { createOatClient, type OatRequest } from '@oat/client';
import type { ProfileDto } from '@oat/services/dto/profile';
import type { WorkspaceSettings } from '@oat/services/dto/workspaces';
import { TooltipProvider } from '@oat/ui/components/tooltip';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SettingsPanel, type SettingsSectionId } from './index';

const profile: ProfileDto = {
  name: 'Ada',
  email: 'ada@example.test',
  role: 'Engineer',
  team: 'Design',
  about: '',
  vocabulary: [],
  updatedAt: null,
};
const workspace: WorkspaceSettings = {
  workspace: { id: 'team', name: 'Design', icon: null, slug: 'design' },
  role: 'owner',
  canManage: true,
  canLeave: true,
  canDelete: true,
  lastWorkspace: false,
  restoreDays: 30,
  joining: {
    policy: 'invite_only',
    domains: ['example.test'],
    ownDomain: { domain: 'example.test', listed: true },
  },
  members: [
    {
      userId: 'you',
      name: 'Ada',
      email: profile.email,
      image: null,
      role: 'owner',
      isYou: true,
      assignableRoles: [],
      canRemove: false,
    },
  ],
  inviteRoles: ['owner', 'admin', 'member', 'viewer'],
  invites: [],
  approveRoles: [],
  joinRequests: [],
};

function show(active: SettingsSectionId) {
  let settings = workspace;
  const transport = vi.fn(async ({ path, method, body }: OatRequest) => {
    let result: unknown;
    switch (path) {
      case '/api/profile':
        result = method === 'PUT' ? { ...profile, ...(body as object) } : profile;
        break;
      case '/api/settings/environment':
        result = { ai: 'mock', stt: 'mock', calendar: 'mock', notion: 'mock', oauth: 'mock' };
        break;
      case '/api/settings/pipeline':
        result = { autoEnhance: method === 'PUT', autoSendToNotion: null };
        break;
      case '/api/calendar/google':
        result = { connected: false, email: null, connectedAt: null, hasCalendarScope: false };
        break;
      case '/api/integrations/notion':
        result = null;
        break;
      case '/api/workspaces/team':
        if (method === 'PATCH') {
          settings = { ...settings, workspace: { ...settings.workspace, ...(body as object) } };
          result = { ok: true };
        } else result = settings;
        break;
      default:
        throw new Error('Unexpected request: ' + path);
    }
    return { status: 200, json: async () => result };
  });
  const connect = vi.fn(async () => {});
  const exportNotes = vi.fn(async () => 2);
  render(
    <TooltipProvider>
      <SettingsPanel
        active={active}
        workspaceName="Design"
        theme="light"
        setTheme={vi.fn()}
        services={{
          client: createOatClient(transport),
          workspaceId: 'team',
          connect,
          exportNotes,
          onWorkspaceExited: vi.fn(),
        }}
      />
    </TooltipProvider>,
  );
  return { transport, connect, exportNotes };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves profile fields through the typed client', async () => {
  const { transport } = show('profile');
  const name = await screen.findByLabelText('Name');
  await userEvent.clear(name);
  await userEvent.type(name, 'Ada Lovelace');
  await userEvent.click(screen.getByTestId('profile-save'));
  await waitFor(() =>
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        path: '/api/profile',
        body: expect.objectContaining({ name: 'Ada Lovelace' }),
      }),
    ),
  );
});

it('shows the shared theme and server environment', async () => {
  show('preferences');
  expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeTruthy();
  expect((await screen.findByTestId('integration-ai')).textContent).toBe('Local mock');
});

it('saves the workspace pipeline switch and delegates consent to the platform', async () => {
  const { transport, connect } = show('integrations');
  await userEvent.click(await screen.findByRole('switch', { name: 'Auto-enhance after meetings' }));
  await waitFor(() =>
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        path: '/api/settings/pipeline',
        body: { workspaceId: 'team', autoEnhance: true },
      }),
    ),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
  expect(connect).toHaveBeenCalledWith('notion', 'team');
});

it('updates workspace details and delegates the ZIP export', async () => {
  const { transport, exportNotes } = show('workspace');
  const name = await screen.findByLabelText('Name');
  await userEvent.clear(name);
  await userEvent.type(name, 'Studio');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/workspaces/team',
        body: { name: 'Studio', icon: null },
      }),
    ),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Leave workspace' }));
  await userEvent.click(screen.getByTestId('export-notes'));
  expect(exportNotes).toHaveBeenCalledWith('team');
  expect(await screen.findByText(/Saved 2 notes/)).toBeTruthy();
});

it('shows the viewer’s membership and management controls from the API', async () => {
  show('members');
  expect((await screen.findByTestId('member-row')).textContent).toContain('Ada');
  expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy();
});
