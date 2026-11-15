import {
  createOatAuthClient,
  GOOGLE_CALENDAR_PROVIDER_ID,
  GOOGLE_PROVIDER_ID,
} from '@oat/auth/client';

/** Browser auth client (same origin, `/api/auth`). Client components only. */
export const authClient = createOatAuthClient();

export { GOOGLE_CALENDAR_PROVIDER_ID, GOOGLE_PROVIDER_ID };
