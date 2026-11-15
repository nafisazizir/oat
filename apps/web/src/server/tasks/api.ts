/**
 * Route handlers for "My tasks" (8.4; contract: `src/lib/tasks.ts`), on the shared API layer (`../api/route.ts`:
 * CSRF check, session → actor, JSON errors). Built from injected deps so the int tests run these exact handlers.
 *
 *   GET   /api/tasks?view=assigned|created|all&status=open|done|all&due=any|overdue|soon&today=YYYY-MM-DD
 *         [&workspaceId=…]                          → TaskListResponse (items the user can read)
 *   PATCH /api/tasks/:id { done, baseVersion }      → tick/untick in the note (409 stale_version, 403, 404)
 *   GET   /api/tasks/assignees?documentId=…[&q=…]   → people a task in that note can be assigned to
 */
import { z } from 'zod';

import { TASK_DUE_FILTERS, TASK_STATUSES, TASK_VIEWS } from '@/lib/tasks';

import { badRequest } from '../api/errors';
import { type ApiDeps, apiRoute, readJson } from '../api/route';
import { listAssignees, listTasks, setTaskDone } from './service';

const Id = z.string().min(1).max(100);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const ListQuery = z.object({
  view: z.enum(TASK_VIEWS).default('assigned'),
  status: z.enum(TASK_STATUSES).default('open'),
  due: z.enum(TASK_DUE_FILTERS).default('any'),
  today: Day.optional(),
  workspaceId: Id.optional(),
});

const AssigneesQuery = z.object({
  documentId: Id,
  q: z.string().max(200).default(''),
});

const UpdateTask = z.strictObject({
  done: z.boolean(),
  baseVersion: z.number().int().min(0),
});

function parseQuery<S extends z.ZodType>(schema: S, url: URL, keys: readonly string[]): z.infer<S> {
  const raw = Object.fromEntries([...url.searchParams].filter(([key]) => keys.includes(key)));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw badRequest(`${issue.path.join('.') || 'query'}: ${issue.message}`);
  }
  return parsed.data;
}

const utcToday = () => new Date().toISOString().slice(0, 10);

export function createTasksApi(deps: ApiDeps) {
  return {
    /** `/api/tasks` */
    tasks: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const query = parseQuery(ListQuery, url, ['view', 'status', 'due', 'today', 'workspaceId']);
        return listTasks(db, actor, { ...query, today: query.today ?? utcToday() });
      }),
    },
    /** `/api/tasks/[id]` */
    task: {
      PATCH: apiRoute<{ id: string }>(deps, async ({ db, actor, params, request }) => {
        const id = Id.safeParse(params.id);
        if (!id.success) throw badRequest('Invalid task id.');
        return setTaskDone(db, actor, id.data, await readJson(request, UpdateTask));
      }),
    },
    /** `/api/tasks/assignees` */
    assignees: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const { documentId, q } = parseQuery(AssigneesQuery, url, ['documentId', 'q']);
        return listAssignees(db, actor, documentId, q);
      }),
    },
  };
}

export type TasksApi = ReturnType<typeof createTasksApi>;
