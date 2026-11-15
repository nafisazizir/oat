import { pipelineApi } from '@/server/pipeline/routes';

/** The caller's post-meeting settings per workspace (8.3). See `src/server/pipeline/api.ts`. */
export const { GET, PUT } = pipelineApi.settings;
