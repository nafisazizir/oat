// @vitest-environment jsdom
import { createOatClient, type OatTransport } from '@oat/client';
import type { WorkspaceHost, AppRoute } from '@oat/workspace-ui';
import { hrefOf } from '@oat/workspace-ui/routes';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceFeatureAdapter,
  featureTargetRoute,
  routeFeatureTarget,
} from './workspace-adapter';
import type { AppTarget } from './provider';
import type { SearchSource } from './sources';

const transport: OatTransport = async () => ({ status: 200, json: async () => ({}) });
function setup(platform: WorkspaceHost['platform'] = 'web') {
  const host: WorkspaceHost = {
    platform,
    appOrigin: 'https://oat.test',
    client: createOatClient(transport),
    route: { view: 'home' },
    navigate: vi.fn(),
    hrefOf,
    refresh: vi.fn(),
    online: true,
    Link: ({ route, ...props }) => <a {...props} href={hrefOf(route)} data-host-link />,
  };
  const options = {
    transport,
    workspaceId: 'w',
    user: { id: 'u', name: 'Alex', email: 'alex@example.test' },
    notify: { success: vi.fn(), error: vi.fn() },
  };
  return { host, options };
}

describe('workspace feature adapter', () => {
  it.each<AppTarget>([
    { kind: 'document', id: 'a/b', blockId: 'b1', segmentId: 's1', timeMs: 65000 },
    { kind: 'document', id: 'd1' },
    { kind: 'search', q: 'a & b' },
    { kind: 'search', q: '' },
    { kind: 'tasks' },
    { kind: 'assistant' },
    { kind: 'assistant', threadId: 'th/1' },
  ])('round trips $kind targets through AppRoute', (target) => {
    expect(routeFeatureTarget(featureTargetRoute(target))).toEqual(target);
  });

  it('ignores unrelated routes and invalid time queries', () => {
    expect(routeFeatureTarget({ view: 'settings' })).toBeUndefined();
    expect(routeFeatureTarget({ view: 'search' })).toEqual({ kind: 'search', q: '' });
    expect(routeFeatureTarget({ view: 'document', id: 'd', query: { t: 'NaN' } })).toEqual({
      kind: 'document',
      id: 'd',
    });
  });

  it('uses the workspace client, navigation and prefetch-capable web Link without dropping deep links', () => {
    const { host, options } = setup();
    const adapter = createWorkspaceFeatureAdapter(host, options);
    expect(adapter.client).toBe(host.client);
    expect(adapter.transport).toBe(transport);
    expect(adapter.workspaceId).toBe('w');
    expect(adapter.user).toBe(options.user);
    expect(adapter.notify).toBe(options.notify);
    expect(adapter.searchSources[0]?.id).toBe('server');
    const target: AppTarget = {
      kind: 'document',
      id: 'd',
      blockId: 'b',
      segmentId: 's',
      timeMs: 65000,
    };
    adapter.navigate(target);
    expect(host.navigate).toHaveBeenCalledWith(featureTargetRoute(target));
    const Link = adapter.Link!;
    render(<Link href={adapter.hrefFor!(target)!}>Source</Link>);
    const link = screen.getByRole('link', { name: 'Source' });
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(link.getAttribute('href')).toBe('/d/d?t=65&block=b&seg=s');
    expect(adapter.hrefFor?.({ kind: 'assistant', threadId: 'th1' })).toBe('/assistant?thread=th1');
  });

  it('keeps desktop links imperative and delegates document navigation only when supplied', () => {
    const { host, options } = setup('desktop');
    const openDocument = vi.fn();
    const searchSources: SearchSource[] = [];
    const adapter = createWorkspaceFeatureAdapter(host, {
      ...options,
      openDocument,
      searchSources,
    });
    expect(adapter.hrefFor).toBeUndefined();
    expect(adapter.Link).toBeUndefined();
    expect(adapter.searchSources).toBe(searchSources);
    adapter.navigate({ kind: 'document', id: 'cached', blockId: 'b' });
    expect(openDocument).toHaveBeenCalledWith({
      view: 'document',
      id: 'cached',
      query: { block: 'b' },
    });
    adapter.navigate({ kind: 'tasks' });
    expect(host.navigate).toHaveBeenCalledExactlyOnceWith({ view: 'tasks' });
    createWorkspaceFeatureAdapter(host, options).navigate({
      kind: 'document',
      id: 'page',
      blockId: 'b',
      segmentId: 's',
      timeMs: 65000,
    });
    expect(host.navigate).toHaveBeenLastCalledWith({
      view: 'document',
      id: 'page',
      query: { t: '65', block: 'b', seg: 's' },
    } satisfies AppRoute);
  });
});
