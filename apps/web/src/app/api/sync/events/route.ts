import { syncApi } from '@/server/sync/routes';

// Long-lived SSE response (the stream ends itself a little before this; clients reconnect).
export const maxDuration = 300;

/** SSE invalidation channel (D-19, 3.5). See `src/server/sync/events.ts`. */
export const { GET } = syncApi.events;
