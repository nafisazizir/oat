import 'server-only';

import { createRateLimiter, type RateLimiter } from '@oat/auth';

import { notionConfig, serverEnv } from '@/lib/env';

import { getAuth, getAuthConfig } from '../auth';
import { findCalendarEvent } from '../calendar';
import { createCalendarNotesApi } from '../calendar-notes';
import { getDb } from '../db';
import { operationContext } from '../operation-context';
import { createMeetingApi } from '../meeting';
import type { NotionDeps } from '../notion';
import { createProfileApi, profileKeyterms } from '../profile';
import { createSttTokenRoute } from '../stt-token';
import { createApi } from './handlers';
import { createNotionApi } from './notion';
import type { ApiDeps } from './route';
import { createWorkspaceApi } from './workspaces';

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
export const api = createApi(apiDeps, { rateLimiter: () => apiRateLimiter() });

export const workspaceApi = createWorkspaceApi(apiDeps, {
  context: async (_userId, headers) => {
    const session = await getAuth().api.getSession({ headers });
    if (!session) throw new Error('Authenticated session disappeared.');
    return operationContext(session.user, headers);
  },
});

const holder = globalThis as typeof globalThis & { __oatApiRateLimiter?: RateLimiter };

/** Redis-backed (shared across instances) per-user limits for API routes. */
export function apiRateLimiter(): RateLimiter {
  holder.__oatApiRateLimiter ??= createRateLimiter(serverEnv().REDIS_URL);
  return holder.__oatApiRateLimiter;
}

export function notionDeps(): NotionDeps {
  const config = getAuthConfig();
  return {
    db: getDb(),
    auth: getAuth(),
    config: notionConfig(serverEnv()),
    appUrl: config.baseURL,
    stateSecret: config.secret,
    rateLimiter: apiRateLimiter(),
  };
}

/** Notion (8.1) routes. */
export const notionApi = createNotionApi(apiDeps, notionDeps);

/** `POST /api/stt/token` (2.5, D-17). */
export const sttToken = createSttTokenRoute({
  getSession: apiDeps.getSession,
  allowedOrigins: apiDeps.allowedOrigins,
  env: () => process.env,
  keyterms: (userId) => profileKeyterms(getDb(), userId),
});

/** "About me" (4.6). */
export const profileApi = createProfileApi(apiDeps);

/** Meeting side of meeting notes: times, attendees (3.4). */
export const meetingApi = createMeetingApi(apiDeps);

/** Meeting notes from calendar events (7.3). */
export const calendarNotesApi = createCalendarNotesApi(apiDeps, (userId, eventId) =>
  findCalendarEvent(userId, eventId),
);
