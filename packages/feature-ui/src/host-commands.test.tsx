import { describe, expect, it, vi } from 'vitest';
import { buildHostCommands } from './host-commands';

function setup(native = false) {
  const options = {
    navigate: vi.fn(),
    toggleSidebar: vi.fn(),
    theme: 'dark',
    setTheme: vi.fn(),
    newPage: vi.fn(),
    newNote: native ? undefined : vi.fn(),
    startRecording: native ? vi.fn() : undefined,
    documents: [
      { id: 'doc', title: 'Plan', kind: 'page' },
      { id: 'folder', title: '', kind: 'folder' },
    ],
    workspaces: [
      { id: 'w', name: 'Current' },
      { id: 'other', name: 'Other' },
    ],
    activeWorkspaceId: 'w',
    switchWorkspace: vi.fn(),
    nativeSettings: native,
  };
  const groups = buildHostCommands(options);
  return {
    options,
    groups,
    find: (text: string) => groups.flatMap((g) => g.items).find((i) => i.text === text)!,
  };
}
describe('host commands', () => {
  it.each([false, true])(
    'shares navigation/pages/settings/sidebar/theme/workspaces (native=%s)',
    (native) => {
      const { options, find, groups } = setup(native);
      find('Templates').onSelect();
      expect(options.navigate).toHaveBeenLastCalledWith({ view: 'templates' });
      find('Plan').onSelect();
      expect(options.navigate).toHaveBeenLastCalledWith({ view: 'document', id: 'doc' });
      find('Integrations').onSelect();
      expect(options.navigate).toHaveBeenLastCalledWith({
        view: 'settings',
        section: 'integrations',
      });
      find('Toggle sidebar').onSelect();
      expect(options.toggleSidebar).toHaveBeenCalledOnce();
      expect(find('Dark theme').checked).toBe(true);
      find('Light theme').onSelect();
      expect(options.setTheme).toHaveBeenCalledWith('light');
      find('Switch to Other').onSelect();
      expect(options.switchWorkspace).toHaveBeenCalledWith('other');
      expect(groups.find((g) => g.heading === 'Pages')?.items[1]?.text).toBe('Untitled folder');
      find('Preferences').onSelect();
      expect(options.navigate).toHaveBeenLastCalledWith({ view: 'settings' });
      find('Members').onSelect();
      expect(options.navigate).toHaveBeenLastCalledWith({
        view: 'settings',
        section: native ? 'members' : 'workspace/members',
      });
      find('New page').onSelect();
      expect(options.newPage).toHaveBeenCalledOnce();
      if (native) {
        expect(find('New note')).toBeUndefined();
        find('Start recording').onSelect();
        expect(options.startRecording).toHaveBeenCalledOnce();
      } else {
        expect(find('Start recording')).toBeUndefined();
        find('New note').onSelect();
        expect(options.newNote).toHaveBeenCalledOnce();
      }
    },
  );
  it('omits unavailable creation/recording/workspace actions and handles an empty document list', () => {
    const groups = buildHostCommands({
      navigate: vi.fn(),
      toggleSidebar: vi.fn(),
      theme: 'system',
      setTheme: vi.fn(),
      documents: [],
    });
    expect(groups.find((g) => g.heading === 'Pages')?.items).toEqual([]);
    expect(groups.find((g) => g.heading === 'Actions')?.items.map((i) => i.text)).toEqual([
      'Toggle sidebar',
    ]);
    expect(groups.find((g) => g.heading === 'Workspaces')).toBeUndefined();
  });
  it('does not run host effects during construction and preserves their errors for the host', () => {
    const { options } = setup();
    options.navigate.mockImplementation(() => {
      throw new Error('unavailable');
    });
    const groups = buildHostCommands(options);
    expect(options.navigate).not.toHaveBeenCalled();
    expect(() => groups[0]!.items[0]!.onSelect()).toThrow('unavailable');
  });
});
