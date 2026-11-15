import { syncApi } from '@/server/sync/routes';

/** Change-log pull for desktop sync (D-19, 2.6). See `src/server/sync/api.ts`. */
export const { GET } = syncApi.pull;
