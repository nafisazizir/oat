import { type Context, Hono } from 'hono';

import week from '../../../../../fixtures/calendar/week.json' with { type: 'json' };
import type { MockProvider } from '../../provider.ts';
import { type CalendarFixture, fixtureAnchor, googleDataFromFixture } from './fixture.ts';
import { midnightIn } from './time.ts';
import type { GoogleCalendarListEntry, GoogleDateTime, GoogleEvent } from './types.ts';

/**
 * Google Calendar API v3 subset (stands in for `https://www.googleapis.com`), served at
 * `/gcal/calendar/v3/…`, with the week from `fixtures/calendar/week.json` as data. Clients use
 * `GOOGLE_CALENDAR_BASE_URL=${MOCKS_URL}/gcal`.
 *
 * Read API (what Oat uses):
 * - `GET  /calendar/v3/users/me/calendarList` (`maxResults`, `pageToken`).
 * - `GET  /calendar/v3/calendars/{id}/events`: `timeMin`/`timeMax` (RFC 3339 with offset; overlap =
 *   `end > timeMin && start < timeMax`), `singleEvents=true` (required: the mock only serves expanded
 *   instances), `orderBy=startTime|updated`, `showDeleted`, `maxResults` (default 250, ≤ 2500), `pageToken`,
 *   `syncToken` (changes since, deleted events included as `status: cancelled`; can't be combined with
 *   timeMin/timeMax/orderBy; **410 `fullSyncRequired`** when stale). `nextSyncToken` on the last page.
 *   `primary` is an alias of the first calendar.
 * - `GET  /calendar/v3/calendars/{id}/events/{eventId}`.
 *
 * Write API (tests use it to change data between syncs; Oat never writes): `POST …/events` (insert),
 * `PATCH …/events/{eventId}` (shallow merge), `DELETE …/events/{eventId}` (→ `cancelled`).
 *
 * Auth: `Authorization: Bearer <token>` is required (401 without). Any non-empty token is accepted in dev,
 * except: a JWT whose `exp` has passed or a token revoked with `POST /gcal/_mock/revoke-token` → 401
 * `authError`; a JWT with a `scope` claim lacking a calendar scope → 403 `insufficientPermissions`.
 *
 * Dates: `anchor: 'next-week'` (default; `GCAL_MOCK_ANCHOR=fixture` switches the container) shifts the
 * fixture by whole weeks (wall-clock, per event zone) so its Monday is the first one after now: the week is
 * always upcoming. `anchor: 'fixture'` serves the fixture's own dates (normaliser parity tests).
 *
 * Test controls: `POST /gcal/_mock/expire-sync-tokens` (every sync token → 410),
 * `POST /gcal/_mock/revoke-token` `{ "token": "…" }`.
 */
export interface GcalProviderOptions {
  anchor?: 'fixture' | 'next-week';
  now?: () => number;
  fixture?: CalendarFixture;
}

export const GCAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

const WEEK_MS = 7 * 24 * 3_600_000;
const SYNC_INCOMPATIBLE = [
  'timeMin',
  'timeMax',
  'orderBy',
  'q',
  'updatedMin',
  'iCalUID',
  'privateExtendedProperty',
  'sharedExtendedProperty',
];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

interface Stored {
  event: GoogleEvent;
  seq: number;
  startMs: number;
  endMs: number;
}

interface State {
  weeks: number;
  epoch: string;
  seq: number;
  calendars: GoogleCalendarListEntry[];
  events: Map<string, Map<string, Stored>>;
}

const encodeToken = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeToken<T>(token: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function googleError(c: Context, code: number, reason: string, message: string) {
  const status =
    code === 401
      ? 'UNAUTHENTICATED'
      : code === 403
        ? 'PERMISSION_DENIED'
        : code === 404
          ? 'NOT_FOUND'
          : code === 410
            ? 'GONE'
            : 'INVALID_ARGUMENT';
  return c.json(
    { error: { code, message, errors: [{ domain: 'global', reason, message }], status } },
    code as 400,
  );
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  return decodeToken<Record<string, unknown>>(parts[1]!);
}

export function gcalProvider(options: GcalProviderOptions = {}): MockProvider {
  const fixture = options.fixture ?? (week as CalendarFixture);
  const anchorMode =
    options.anchor ?? (process.env.GCAL_MOCK_ANCHOR === 'fixture' ? 'fixture' : 'next-week');
  const now = options.now ?? Date.now;
  const anchorMs = fixtureAnchor(fixture);
  const zone = fixture.timeZone ?? 'UTC';
  let epochCounter = 0;
  const revoked = new Set<string>();

  const weeksFor = (t: number) =>
    anchorMode === 'fixture' || t < anchorMs ? 0 : Math.floor((t - anchorMs) / WEEK_MS) + 1;

  function bounds(event: GoogleEvent, tz: string): { startMs: number; endMs: number } {
    const at = (d: GoogleDateTime) =>
      d.dateTime ? Date.parse(d.dateTime) : midnightIn(d.date ?? '1970-01-01', tz);
    const startMs = at(event.start);
    return { startMs, endMs: Math.max(startMs, at(event.end)) };
  }

  function build(weeks: number): State {
    const data = googleDataFromFixture(fixture, { weeks, updated: new Date(now()).toISOString() });
    let seq = 0;
    const events = new Map<string, Map<string, Stored>>();
    for (const cal of data.calendars) {
      const byId = new Map<string, Stored>();
      for (const event of data.events.get(cal.id) ?? []) {
        seq++;
        byId.set(event.id, { event: { ...event, etag: `"${seq}"` }, seq, ...bounds(event, zone) });
      }
      events.set(cal.id, byId);
    }
    return {
      weeks,
      epoch: `${now().toString(36)}.${epochCounter++}`,
      seq,
      calendars: data.calendars,
      events,
    };
  }

  let state = build(weeksFor(now()));
  const current = (): State => {
    const weeks = weeksFor(now());
    if (weeks !== state.weeks) state = build(weeks);
    return state;
  };

  function calendarOf(s: State, id: string): GoogleCalendarListEntry | undefined {
    return id === 'primary'
      ? s.calendars.find((c) => c.primary)
      : s.calendars.find((c) => c.id === id);
  }

  function touch(s: State, cal: GoogleCalendarListEntry, event: GoogleEvent): Stored {
    s.seq++;
    const stored: Stored = {
      event: { ...event, etag: `"${s.seq}"`, updated: new Date(now()).toISOString() },
      seq: s.seq,
      ...bounds(event, cal.timeZone),
    };
    s.events.get(cal.id)!.set(event.id, stored);
    return stored;
  }

  const app = new Hono();

  // --- test controls (not part of Google's API) ---------------------------------------------------------
  app.post('/_mock/expire-sync-tokens', (c) => {
    const s = current();
    s.epoch = `${now().toString(36)}.${epochCounter++}`;
    return c.json({ ok: true });
  });
  app.post('/_mock/revoke-token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token === '') {
      return c.json({ error: 'body must be { "token": "<access token>" }' }, 400);
    }
    revoked.add(body.token);
    return c.json({ ok: true });
  });

  // --- auth --------------------------------------------------------------------------------------------
  app.use('/calendar/v3/*', async (c, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    if (!match) {
      return googleError(
        c,
        401,
        'required',
        'Request is missing required authentication credential. Expected OAuth 2 access token.',
      );
    }
    const token = match[1]!;
    const claims = jwtPayload(token);
    const expired = typeof claims?.exp === 'number' && claims.exp * 1000 <= now();
    if (revoked.has(token) || expired) {
      return googleError(c, 401, 'authError', 'Invalid Credentials');
    }
    if (
      typeof claims?.scope === 'string' &&
      !claims.scope.split(' ').some((s) => GCAL_SCOPES.includes(s))
    ) {
      return googleError(
        c,
        403,
        'insufficientPermissions',
        'Request had insufficient authentication scopes.',
      );
    }
    await next();
  });

  // --- calendarList ------------------------------------------------------------------------------------
  app.get('/calendar/v3/users/me/calendarList', (c) => {
    const s = current();
    const { maxResults, pageToken } = c.req.query();
    const max = maxResults === undefined ? 100 : Number(maxResults);
    if (!Number.isInteger(max) || max < 1 || max > 250) {
      return googleError(c, 400, 'invalid', 'Invalid value for: maxResults');
    }
    const offset = pageToken ? decodeToken<{ o: number }>(pageToken)?.o : 0;
    if (offset === undefined || !Number.isInteger(offset)) {
      return googleError(c, 400, 'invalid', 'Invalid page token value.');
    }
    const page = s.calendars.slice(offset, offset + max);
    const more = offset + max < s.calendars.length;
    return c.json({
      kind: 'calendar#calendarList',
      etag: `"${s.epoch}"`,
      items: page,
      ...(more
        ? { nextPageToken: encodeToken({ o: offset + max }) }
        : { nextSyncToken: encodeToken({ list: true, e: s.epoch }) }),
    });
  });

  // --- events ------------------------------------------------------------------------------------------
  app.get('/calendar/v3/calendars/:calendarId/events', (c) => {
    const s = current();
    const cal = calendarOf(s, c.req.param('calendarId'));
    if (!cal) return googleError(c, 404, 'notFound', 'Not Found');
    const q = c.req.query();

    const max = q.maxResults === undefined ? 250 : Number(q.maxResults);
    if (!Number.isInteger(max) || max < 1 || max > 2500) {
      return googleError(c, 400, 'invalid', 'Invalid value for: maxResults');
    }
    if (q.singleEvents !== 'true') {
      return googleError(
        c,
        400,
        'badRequest',
        'The mock only serves expanded instances: pass singleEvents=true.',
      );
    }
    if (q.orderBy !== undefined && q.orderBy !== 'startTime' && q.orderBy !== 'updated') {
      return googleError(c, 400, 'invalid', 'Invalid value for: orderBy');
    }

    // Everything except pageToken identifies the query a page token belongs to.
    const fingerprint = Object.entries(q)
      .filter(([k]) => k !== 'pageToken')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    let offset = 0;
    let since: number | undefined;
    let snapshot = s.seq;
    if (q.pageToken) {
      const page = decodeToken<{ o: number; s: number; f: string }>(q.pageToken);
      if (!page || page.f !== fingerprint || !Number.isInteger(page.o)) {
        return googleError(c, 400, 'invalid', 'Invalid page token value.');
      }
      offset = page.o;
      snapshot = page.s;
    }

    let items: Stored[] = [...(s.events.get(cal.id)?.values() ?? [])];
    if (q.syncToken) {
      const clash = SYNC_INCOMPATIBLE.find((k) => q[k] !== undefined);
      if (clash) {
        return googleError(
          c,
          400,
          'invalid',
          `The syncToken parameter can't be used with ${clash}.`,
        );
      }
      const sync = decodeToken<{ c: string; s: number; e: string }>(q.syncToken);
      if (!sync || sync.c !== cal.id || sync.e !== s.epoch || !Number.isInteger(sync.s)) {
        return googleError(
          c,
          410,
          'fullSyncRequired',
          'Sync token is no longer valid, a full sync is required.',
        );
      }
      since = sync.s;
      items = items.filter((x) => x.seq > since!);
    } else {
      for (const [key, value] of [
        ['timeMin', q.timeMin],
        ['timeMax', q.timeMax],
      ] as const) {
        if (value !== undefined && (!RFC3339.test(value) || Number.isNaN(Date.parse(value)))) {
          return googleError(
            c,
            400,
            'badRequest',
            `Bad Request: ${key} must be RFC 3339 with an offset`,
          );
        }
      }
      const timeMin = q.timeMin ? Date.parse(q.timeMin) : -Infinity;
      const timeMax = q.timeMax ? Date.parse(q.timeMax) : Infinity;
      items = items.filter(
        (x) =>
          (q.showDeleted === 'true' || x.event.status !== 'cancelled') &&
          x.endMs > timeMin &&
          x.startMs < timeMax,
      );
    }

    items.sort((a, b) =>
      q.orderBy === 'updated'
        ? a.event.updated.localeCompare(b.event.updated) || a.event.id.localeCompare(b.event.id)
        : a.startMs - b.startMs || a.event.id.localeCompare(b.event.id),
    );
    const page = items.slice(offset, offset + max);
    const more = offset + max < items.length;
    const updated = items.reduce(
      (latest, x) => (x.event.updated > latest ? x.event.updated : latest),
      '',
    );
    return c.json({
      kind: 'calendar#events',
      etag: `"${s.seq}"`,
      summary: cal.summary,
      description: '',
      updated: updated || new Date(now()).toISOString(),
      timeZone: cal.timeZone,
      accessRole: cal.accessRole,
      defaultReminders: [],
      items: page.map((x) => x.event),
      ...(more
        ? { nextPageToken: encodeToken({ o: offset + max, s: snapshot, f: fingerprint }) }
        : { nextSyncToken: encodeToken({ c: cal.id, s: snapshot, e: s.epoch }) }),
    });
  });

  app.get('/calendar/v3/calendars/:calendarId/events/:eventId', (c) => {
    const s = current();
    const cal = calendarOf(s, c.req.param('calendarId'));
    const stored = cal && s.events.get(cal.id)?.get(c.req.param('eventId'));
    if (!stored) return googleError(c, 404, 'notFound', 'Not Found');
    return c.json(stored.event);
  });

  app.post('/calendar/v3/calendars/:calendarId/events', async (c) => {
    const s = current();
    const cal = calendarOf(s, c.req.param('calendarId'));
    if (!cal) return googleError(c, 404, 'notFound', 'Not Found');
    const body = (await c.req.json().catch(() => null)) as Partial<GoogleEvent> | null;
    if (!body?.start || !body.end) {
      return googleError(c, 400, 'required', 'Missing start or end time.');
    }
    const id = body.id ?? `mock${s.seq + 1}`;
    if (s.events.get(cal.id)!.has(id))
      return googleError(c, 409, 'duplicate', 'The requested identifier already exists.');
    const stored = touch(s, cal, {
      ...body,
      kind: 'calendar#event',
      etag: '',
      id,
      status: body.status ?? 'confirmed',
      updated: '',
      start: body.start,
      end: body.end,
      iCalUID: body.iCalUID ?? `${id}@google.com`,
      sequence: 0,
      eventType: body.eventType ?? 'default',
    });
    return c.json(stored.event);
  });

  app.patch('/calendar/v3/calendars/:calendarId/events/:eventId', async (c) => {
    const s = current();
    const cal = calendarOf(s, c.req.param('calendarId'));
    const stored = cal && s.events.get(cal.id)?.get(c.req.param('eventId'));
    if (!cal || !stored) return googleError(c, 404, 'notFound', 'Not Found');
    const body = (await c.req.json().catch(() => null)) as Partial<GoogleEvent> | null;
    if (!body || typeof body !== 'object') return googleError(c, 400, 'parseError', 'Parse Error');
    const next = touch(s, cal, {
      ...stored.event,
      ...body,
      id: stored.event.id,
      sequence: stored.event.sequence + 1,
    });
    return c.json(next.event);
  });

  app.delete('/calendar/v3/calendars/:calendarId/events/:eventId', (c) => {
    const s = current();
    const cal = calendarOf(s, c.req.param('calendarId'));
    const stored = cal && s.events.get(cal.id)?.get(c.req.param('eventId'));
    if (!cal || !stored) return googleError(c, 404, 'notFound', 'Not Found');
    if (stored.event.status === 'cancelled') {
      return googleError(c, 410, 'deleted', 'Resource has been deleted');
    }
    touch(s, cal, { ...stored.event, status: 'cancelled' });
    return c.body(null, 204);
  });

  return {
    name: 'gcal',
    description:
      'Google Calendar API v3 subset (calendarList, events list/sync) over the fixture week.',
    app,
    reset: () => {
      revoked.clear();
      state = build(weeksFor(now()));
    },
  };
}
