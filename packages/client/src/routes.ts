import { createOatClient } from './client.ts';
import type { OatRequest } from './transport.ts';

export type ApiRoute = { path: string; methods: readonly OatRequest['method'][] };

const routes = new Map<string, Set<OatRequest['method']>>();
function collect(value: unknown): void {
  if (typeof value === 'function' && 'endpoint' in value) {
    const { method, path } = value.endpoint as { method: OatRequest['method']; path: string };
    const methods = routes.get(path) ?? new Set<OatRequest['method']>();
    methods.add(method);
    routes.set(path, methods);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(collect);
  }
}
collect(
  createOatClient(async () => {
    throw new Error('Route inventory does not dispatch.');
  }),
);

/** One inventory, derived from actual client endpoint declarations; excludes OAuth and non-feature APIs. */
export const apiRoutes: readonly ApiRoute[] = Object.freeze(
  [...routes].map(([path, methods]) =>
    Object.freeze({ path, methods: Object.freeze([...methods]) }),
  ),
);
