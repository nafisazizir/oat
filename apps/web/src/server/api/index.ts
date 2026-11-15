import 'server-only';

import { getAuth, getAuthConfig } from '../auth';
import { getDb } from '../db';
import { createApi } from './handlers';
import type { ApiDeps } from './route';

/** The real database and Better Auth, as API deps (shared by every route family). */
export const apiDeps: ApiDeps = {
  db: getDb,
  getSession: (headers) => getAuth().api.getSession({ headers }),
  allowedOrigins: () => {
    const config = getAuthConfig();
    return [
      new URL(config.baseURL).origin,
      ...config.trustedOrigins.map((o) => o.replace(/\/+$/, '')),
    ];
  },
};

/** The app's API handlers, bound to the real deps (route files re-export these). */
export const api = createApi(apiDeps);
