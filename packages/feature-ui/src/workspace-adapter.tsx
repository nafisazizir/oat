import type { AppRoute, WorkspaceHost } from '@oat/workspace-ui';
import { routeOf } from '@oat/workspace-ui/routes';
import type { AppTarget, FeatureUiAdapter, LinkComponent } from './provider';
import { serverSearchSource } from './sources';

export type FeatureRoute = Extract<
  AppRoute,
  { view: 'document' | 'tasks' | 'assistant' | 'search' }
>;
export type WorkspaceFeatureOptions = Pick<
  FeatureUiAdapter,
  'transport' | 'notify' | 'workspaceId' | 'user'
> & {
  searchSources?: FeatureUiAdapter['searchSources'];
  openDocument?(route: Extract<AppRoute, { view: 'document' }>): void;
};

export function featureTargetRoute(target: AppTarget): FeatureRoute {
  switch (target.kind) {
    case 'document': {
      const query: Record<string, string> = {};
      if (target.timeMs !== undefined) query.t = String(Math.floor(target.timeMs / 1000));
      if (target.blockId) query.block = target.blockId;
      if (target.segmentId) query.seg = target.segmentId;
      return { view: 'document', id: target.id, ...(Object.keys(query).length ? { query } : {}) };
    }
    case 'search':
      return { view: 'search', q: target.q };
    case 'tasks':
      return { view: 'tasks' };
    case 'assistant':
      return { view: 'assistant', ...(target.threadId ? { threadId: target.threadId } : {}) };
  }
}

export function routeFeatureTarget(route: AppRoute): AppTarget | undefined {
  switch (route.view) {
    case 'document': {
      const seconds = route.query?.t ? Number(route.query.t) : NaN;
      return {
        kind: 'document',
        id: route.id,
        ...(route.query?.block ? { blockId: route.query.block } : {}),
        ...(route.query?.seg ? { segmentId: route.query.seg } : {}),
        ...(Number.isFinite(seconds) && seconds >= 0 ? { timeMs: seconds * 1000 } : {}),
      };
    }
    case 'search':
      return { kind: 'search', q: route.q ?? '' };
    case 'tasks':
      return { kind: 'tasks' };
    case 'assistant':
      return { kind: 'assistant', ...(route.threadId ? { threadId: route.threadId } : {}) };
    default:
      return undefined;
  }
}

export function createWorkspaceFeatureAdapter(
  host: WorkspaceHost,
  options: WorkspaceFeatureOptions,
): FeatureUiAdapter {
  const Link: LinkComponent = ({ href, ...props }) => {
    const base = new URL(host.appOrigin || 'https://oat.invalid');
    const url = new URL(href, base);
    if (url.origin !== base.origin)
      return <a {...props} href={url.href} target="_blank" rel="noopener noreferrer" />;
    return <host.Link {...props} route={routeOf(url.pathname, url.search)} />;
  };
  return {
    client: host.client,
    transport: options.transport,
    notify: options.notify,
    workspaceId: options.workspaceId,
    user: options.user,
    searchSources: options.searchSources ?? [serverSearchSource(host.client)],
    navigate(target) {
      const route = featureTargetRoute(target);
      if (route.view === 'document' && options.openDocument) options.openDocument(route);
      else host.navigate(route);
    },
    ...(host.platform === 'web'
      ? { hrefFor: (target: AppTarget) => host.hrefOf(featureTargetRoute(target)), Link }
      : {}),
  };
}
