import { createOatAuthClient, GOOGLE_PROVIDER_ID } from '@oat/auth/client';

/** Browser auth client (same origin, `/api/auth`). Client components only. */
export const authClient = createOatAuthClient();

export { GOOGLE_PROVIDER_ID };
