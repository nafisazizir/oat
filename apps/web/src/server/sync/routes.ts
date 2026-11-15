import 'server-only';

import { apiDeps, apiRateLimiter } from '../api';
import { createSyncApi } from './api';

/** The sync API bound to the app's database and Better Auth (route files re-export these). */
export const syncApi = createSyncApi(apiDeps, { rateLimiter: apiRateLimiter });
