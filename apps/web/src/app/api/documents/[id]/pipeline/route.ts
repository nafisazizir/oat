import { pipelineApi } from '@/server/pipeline/routes';

/** Post-meeting pipeline status / start + retry (8.3). See `src/server/pipeline/api.ts`. */
export const { GET, POST } = pipelineApi.run;
