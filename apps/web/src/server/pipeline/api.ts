/**
 * Post-meeting pipeline routes (8.3, D-29) on the shared API layer (`../api/route.ts`: CSRF check for cookie
 * writes → session → actor). The rules live in `@oat/services/pipeline`; contract: `@/lib/pipeline`.
 *
 *   GET  /api/documents/:id/pipeline      { run, meetingEnded, canRun } (read access; a due waiting run is
 *                                         handed over again)
 *   POST /api/documents/:id/pipeline      same: start / run again after a newer end / retry (owner or editor;
 *                                         the meeting has ended)
 *   GET  /api/settings/pipeline?workspaceId=   PipelineSettingsDto (member; the caller's own settings)
 *   PUT  /api/settings/pipeline           { workspaceId, autoEnhance?, autoSendToNotion? }
 */
import {
  getPipelineSettings,
  getPostMeetingRun,
  type PipelineDeps,
  retryPostMeeting,
  updatePipelineSettings,
} from '@oat/services/pipeline';
import { z } from 'zod';

import type { PipelineRunResponse, PipelineSettingsDto } from '@/lib/pipeline';

import { badRequest } from '../api/errors';
import { type ApiDeps, apiRoute, readJson } from '../api/route';

const Id = z.string().min(1).max(100);

const UpdateSettings = z.strictObject({
  workspaceId: Id,
  autoEnhance: z.boolean().optional(),
  autoSendToNotion: z.boolean().optional(),
});

export function createPipelineApi(deps: ApiDeps, pipeline: () => PipelineDeps) {
  return {
    /** `/api/documents/[id]/pipeline` */
    run: {
      GET: apiRoute<{ id: string }>(deps, async ({ actor, params }): Promise<PipelineRunResponse> =>
        getPostMeetingRun(pipeline(), actor, params.id),
      ),
      POST: apiRoute<{ id: string }>(
        deps,
        async ({ actor, params }): Promise<PipelineRunResponse> =>
          retryPostMeeting(pipeline(), actor, params.id),
      ),
    },
    /** `/api/settings/pipeline` */
    settings: {
      GET: apiRoute(deps, async ({ db, actor, url }): Promise<PipelineSettingsDto> => {
        const workspaceId = Id.safeParse(url.searchParams.get('workspaceId'));
        if (!workspaceId.success) throw badRequest('workspaceId is required.');
        return getPipelineSettings(db, actor, workspaceId.data);
      }),
      PUT: apiRoute(deps, async ({ db, actor, request }): Promise<PipelineSettingsDto> =>
        updatePipelineSettings(db, actor, await readJson(request, UpdateSettings)),
      ),
    },
  };
}

export type PipelineApi = ReturnType<typeof createPipelineApi>;
