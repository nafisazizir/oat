import { syncApi } from '@/server/sync/routes';

/** Subtree backfill for a document a client sees for the first time (3.5). See `src/server/sync/api.ts`. */
export const { GET } = syncApi.backfill;
