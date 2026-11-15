import 'server-only';

import { getAuth, getAuthConfig } from '../auth';
import { getDb } from '../db';
import { createApi } from './handlers';

/** The app's API handlers, bound to the real database and Better Auth (route files re-export these). */
export const api = createApi({
  db: getDb,
  getSession: (headers) => getAuth().api.getSession({ headers }),
  allowedOrigins: () => {
    const config = getAuthConfig();
    return [
      new URL(config.baseURL).origin,
      ...config.trustedOrigins.map((o) => o.replace(/\/+$/, '')),
    ];
  },
});
