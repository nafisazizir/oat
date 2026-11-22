import {
  TASK_VIEWS,
  TASK_STATUSES,
  TASK_DUE_FILTERS,
  type TaskView,
  type TaskStatus,
  type TaskDueFilter,
} from '@oat/services/dto/tasks';

export type RouteTaskFilters = { view: TaskView; status: TaskStatus; due: TaskDueFilter };
export type AppRoute =
  | { view: 'home' }
  | { view: 'document'; id: string; query?: Record<string, string> }
  | { view: 'templates' }
  | { view: 'template'; id: string }
  | { view: 'template-new' }
  | { view: 'tasks'; filters?: RouteTaskFilters }
  | { view: 'assistant'; threadId?: string }
  | { view: 'search'; q?: string; type?: 'notes' | 'transcripts' }
  | { view: 'settings'; section?: string }
  | { view: 'join' }
  | { view: 'invite'; token: string };

export function hrefOf(route: AppRoute): string {
  switch (route.view) {
    case 'invite':
      return `/invite/${encodeURIComponent(route.token)}`;
    case 'document': {
      const query = new URLSearchParams(route.query).toString();
      return `/d/${encodeURIComponent(route.id)}${query ? `?${query}` : ''}`;
    }
    case 'template':
      return `/templates/${encodeURIComponent(route.id)}`;
    case 'template-new':
      return '/templates/new';
    case 'assistant':
      return `/assistant${route.threadId ? `?${new URLSearchParams({ thread: route.threadId })}` : ''}`;
    case 'search':
    case 'tasks': {
      const query = new URLSearchParams(
        route.view === 'tasks'
          ? route.filters
          : {
              ...(route.q !== undefined ? { q: route.q } : {}),
              ...(route.type ? { type: route.type } : {}),
            },
      );
      return `/${route.view}${query.size ? `?${query}` : ''}`;
    }
    case 'settings':
      return `/settings${route.section ? `/${route.section.split('/').map(encodeURIComponent).join('/')}` : ''}`;
    default:
      return `/${route.view}`;
  }
}

export function routeOf(pathname: string, search: string | URLSearchParams = ''): AppRoute {
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const query = new URLSearchParams(search);
  switch (parts[0]) {
    case 'invite':
      if (parts[1]) return { view: 'invite', token: parts[1] };
      break;
    case 'd':
      if (parts[1])
        return {
          view: 'document',
          id: parts[1],
          ...(query.size ? { query: Object.fromEntries(query) } : {}),
        };
      break;
    case 'templates':
      return parts[1] === 'new'
        ? { view: 'template-new' }
        : parts[1]
          ? { view: 'template', id: parts[1] }
          : { view: 'templates' };
    case 'assistant':
      return {
        view: 'assistant',
        ...(parts[1] || query.get('thread') ? { threadId: parts[1] || query.get('thread')! } : {}),
      };
    case 'search':
      return {
        view: 'search',
        ...(query.has('q') ? { q: query.get('q')! } : {}),
        ...(query.get('type') === 'notes' || query.get('type') === 'transcripts'
          ? { type: query.get('type') as 'notes' | 'transcripts' }
          : {}),
      };
    case 'settings':
      return {
        view: 'settings',
        ...(parts.length > 1 ? { section: parts.slice(1).join('/') } : {}),
      };
    case 'tasks':
      return {
        view: 'tasks',
        ...(['view', 'status', 'due'].some((key) => query.has(key))
          ? {
              filters: {
                view: TASK_VIEWS.includes(query.get('view') as TaskView)
                  ? (query.get('view') as TaskView)
                  : 'assigned',
                status: TASK_STATUSES.includes(query.get('status') as TaskStatus)
                  ? (query.get('status') as TaskStatus)
                  : 'open',
                due: TASK_DUE_FILTERS.includes(query.get('due') as TaskDueFilter)
                  ? (query.get('due') as TaskDueFilter)
                  : 'any',
              },
            }
          : {}),
      };
    case 'join':
      return { view: 'join' };
  }
  return { view: 'home' };
}

export const sections = {
  home: { label: 'Home', href: '/home' },
  search: { label: 'Search', href: '/search' },
  tasks: { label: 'My tasks', href: '/tasks' },
  assistant: { label: 'Assistant', href: '/assistant' },
  templates: { label: 'Templates', href: '/templates' },
  settings: { label: 'Settings', href: '/settings' },
} as const;

export function inSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
