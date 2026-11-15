import { syncApi } from '@/server/sync/routes';

/** Desktop outbox push (D-19, 2.6). See `src/server/sync/api.ts`. */
export const { POST } = syncApi.push;
