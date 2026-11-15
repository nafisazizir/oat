import 'server-only';

import { apiDeps, apiRateLimiter } from '../api';
import { onMeetingEnded } from '../pipeline/routes';
import { createSyncApi } from './api';

/**
 * The sync API bound to the app's database and Better Auth (route files re-export these). A pushed meeting end
 * starts the post-meeting pipeline (8.3).
 */
export const syncApi = createSyncApi(apiDeps, { rateLimiter: apiRateLimiter, onMeetingEnded });
