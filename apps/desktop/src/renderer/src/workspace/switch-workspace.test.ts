import { OatApiError } from '@oat/client';
import { describe, expect, it, vi } from 'vitest';
import { switchDesktopWorkspace } from './switch-workspace';

describe('desktop workspace switching', () => {
  it('persists a cached offline choice without calling the server', async () => {
    const local = vi.fn().mockResolvedValue(undefined);
    const remote = vi.fn();
    await switchDesktopWorkspace('cached', false, local, remote);
    expect(local).toHaveBeenCalledWith('cached');
    expect(remote).not.toHaveBeenCalled();
  });
  it('switches through REST online, leaving persistence to the API observer', async () => {
    const local = vi.fn();
    const remote = vi.fn().mockResolvedValue({ ok: true });
    await switchDesktopWorkspace('next', true, local, remote);
    expect(remote).toHaveBeenCalledWith('next');
    expect(local).not.toHaveBeenCalled();
  });
  it('falls back locally if the network fails during switching', async () => {
    const local = vi.fn().mockResolvedValue(undefined);
    await switchDesktopWorkspace(
      'cached',
      true,
      local,
      vi.fn().mockRejectedValue(new OatApiError(0, 'network', 'Offline')),
    );
    expect(local).toHaveBeenCalledWith('cached');
  });
  it('does not bypass a server refusal or hide a local persistence failure', async () => {
    const local = vi.fn();
    await expect(
      switchDesktopWorkspace(
        'forbidden',
        true,
        local,
        vi.fn().mockRejectedValue(new OatApiError(403, 'forbidden', 'Denied')),
      ),
    ).rejects.toThrow('Denied');
    expect(local).not.toHaveBeenCalled();
    local.mockRejectedValue(new Error('No cached workspace'));
    await expect(switchDesktopWorkspace('missing', false, local)).rejects.toThrow(
      'No cached workspace',
    );
  });
});
