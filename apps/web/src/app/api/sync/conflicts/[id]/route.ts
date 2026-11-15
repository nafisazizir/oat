import { syncApi } from '@/server/sync/routes';

/** A conflicted copy: compare (GET) and resolve (POST) (3.5). See `src/server/sync/conflicts.ts`. */
export const { GET, POST } = syncApi.conflict;
