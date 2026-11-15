/**
 * Route handlers for `/api/templates` and `/api/templates/:id` (contract: `src/lib/templates.ts`), on the
 * shared API layer (`../api/route.ts`: CSRF check, session → actor, JSON errors). Built from injected deps so
 * the int tests run these exact handlers against a throwaway database.
 */
import { templateInputSchema, templatePatchSchema } from '@oat/ai/templates';
import { z } from 'zod';

import { badRequest } from '../api/errors';
import { type ApiDeps, apiRoute, readJson } from '../api/route';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from './service';

const Id = z.string().min(1).max(100);
const CreateBody = templateInputSchema.extend({ workspaceId: Id });
const DuplicateBody = z.strictObject({ workspaceId: Id, fromTemplateId: Id });
/** Either shape; parsed precisely below so a bad create gets its own field error, not a union error. */
const AnyBody = z.looseObject({});

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${path}${issue.message}`);
  }
  return parsed.data;
}

type IdParams = { id: string };

export function createTemplatesApi(deps: ApiDeps) {
  return {
    /** `/api/templates` */
    templates: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const workspaceId = Id.safeParse(url.searchParams.get('workspaceId'));
        if (!workspaceId.success) throw badRequest('workspaceId is required.');
        return listTemplates(db, actor.ctx, workspaceId.data);
      }),
      /** Create, or duplicate with `{ workspaceId, fromTemplateId }`. */
      POST: apiRoute(
        deps,
        async ({ db, actor, request }) => {
          const body = await readJson(request, AnyBody);
          if ('fromTemplateId' in body) {
            const { workspaceId, fromTemplateId } = parse(DuplicateBody, body);
            return duplicateTemplate(db, actor.ctx, workspaceId, fromTemplateId);
          }
          const { workspaceId, ...input } = parse(CreateBody, body);
          return createTemplate(db, actor.ctx, workspaceId, input);
        },
        { status: 201 },
      ),
    },
    /** `/api/templates/[id]` (`?workspaceId` only affects `canDuplicate` for built-ins). */
    template: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params, url }) =>
        getTemplate(db, actor.ctx, params.id, { workspaceId: url.searchParams.get('workspaceId') }),
      ),
      PATCH: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        updateTemplate(db, actor.ctx, params.id, await readJson(request, templatePatchSchema)),
      ),
      DELETE: apiRoute<IdParams>(deps, async ({ db, actor, params }) => {
        await deleteTemplate(db, actor.ctx, params.id);
      }),
    },
  };
}

export type TemplatesApi = ReturnType<typeof createTemplatesApi>;
