import { z } from 'zod';

import { getAuth } from '@/server/auth';
import { listUpcomingMeetings, UPCOMING_HORIZON_MS, UPCOMING_LIMIT } from '@/server/calendar';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(UPCOMING_LIMIT),
  // ≤ 21 keeps every request inside the source's synced window (28 days), so reads stay incremental.
  days: z.coerce.number().int().min(1).max(21).optional(),
});

/**
 * `GET /api/calendar/upcoming?limit=5&days=14` (days ≤ 21) → `{ connected, sources, events }`: the signed-in user's
 * in-progress and upcoming events from every connected calendar, merged (`CalendarEvent` JSON, ISO dates).
 * Session cookie or `Authorization: Bearer` (desktop). 401 without a session.
 */
export async function GET(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  const url = new URL(request.url);
  const query = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return Response.json(
      { error: 'invalid_query', issues: query.error.issues.map((i) => i.path.join('.')) },
      { status: 400, headers: NO_STORE },
    );
  }
  const result = await listUpcomingMeetings(session.user.id, {
    limit: query.data.limit,
    horizonMs: query.data.days ? query.data.days * 24 * 3_600_000 : UPCOMING_HORIZON_MS,
  });
  return Response.json(result, { headers: NO_STORE });
}
