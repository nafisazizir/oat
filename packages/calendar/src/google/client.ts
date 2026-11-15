/**
 * Minimal Google Calendar API v3 client (fetch only): the calendar list and event lists, following every
 * page. Tokens come from the caller (`getAccessToken`, e.g. Better Auth's stored account token, refreshed
 * when it expires); a 401 asks for a forced refresh and retries once.
 */
import type { z } from 'zod';

import {
  type GoogleCalendarListEntry,
  GoogleCalendarListPageSchema,
  GoogleErrorSchema,
  type GoogleEvent,
  GoogleEventsPageSchema,
} from './api.ts';

export type GoogleAccessTokenProvider = (options: { forceRefresh: boolean }) => Promise<string>;

export interface GoogleCalendarClientOptions {
  /** API origin (+ optional path prefix) before `/calendar/v3`: `https://www.googleapis.com` or `${MOCKS_URL}/gcal`. */
  baseUrl: string;
  getAccessToken: GoogleAccessTokenProvider;
  /** Page size for event lists (Google: default 250, max 2500). */
  maxResults?: number;
  /** Per HTTP request. Default 15 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A non-2xx answer from the API. `reason` is Google's `errors[0].reason` when present. */
export class GoogleCalendarApiError extends Error {
  override name = 'GoogleCalendarApiError';
  readonly status: number;
  readonly reason: string | undefined;
  constructor(message: string, status: number, reason: string | undefined, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.reason = reason;
  }
}

/** No usable credentials: the token was refused after a refresh, lacks the calendar scope, or none could be obtained. Reconnecting fixes it. */
export class GoogleCalendarAuthError extends GoogleCalendarApiError {
  override name = 'GoogleCalendarAuthError';
}

/** 410 on a sync token: the caller must drop its state for that calendar and do a full sync. */
export class GoogleSyncTokenExpiredError extends GoogleCalendarApiError {
  override name = 'GoogleSyncTokenExpiredError';
}

export interface ListEventsParams {
  timeMin?: Date;
  timeMax?: Date;
  syncToken?: string;
  showDeleted?: boolean;
}

export interface EventList {
  items: GoogleEvent[];
  /** From the last page; null if the API didn't send one. */
  nextSyncToken: string | null;
  /** The calendar's zone as the events list reports it. */
  timeZone: string | null;
}

/** Safety net against a server that keeps handing out page tokens. */
const MAX_PAGES = 100;

export class GoogleCalendarClient {
  readonly #baseUrl: string;
  readonly #getAccessToken: GoogleAccessTokenProvider;
  readonly #maxResults: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /** HTTP requests made (tests). */
  requestCount = 0;

  constructor(options: GoogleCalendarClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#getAccessToken = options.getAccessToken;
    this.#maxResults = options.maxResults ?? 250;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Every entry of the user's calendar list. */
  async listCalendars(): Promise<GoogleCalendarListEntry[]> {
    const items: GoogleCalendarListEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ maxResults: '250' });
      if (pageToken) query.set('pageToken', pageToken);
      const body = await this.#get(
        '/calendar/v3/users/me/calendarList',
        query,
        GoogleCalendarListPageSchema,
      );
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) return items;
    }
    throw new GoogleCalendarApiError('calendarList: too many pages', 500, undefined);
  }

  /**
   * Every event of a list query (expanded instances: `singleEvents=true`). A full query takes
   * timeMin/timeMax; an incremental one only `syncToken` (Google refuses the combination) and may throw
   * `GoogleSyncTokenExpiredError`.
   */
  async listEvents(calendarId: string, params: ListEventsParams): Promise<EventList> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let timeZone: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        singleEvents: 'true',
        maxResults: String(this.#maxResults),
      });
      if (params.syncToken) {
        query.set('syncToken', params.syncToken);
      } else {
        if (params.timeMin) query.set('timeMin', params.timeMin.toISOString());
        if (params.timeMax) query.set('timeMax', params.timeMax.toISOString());
        if (params.showDeleted) query.set('showDeleted', 'true');
      }
      if (pageToken) query.set('pageToken', pageToken);
      const body = await this.#get(
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        query,
        GoogleEventsPageSchema,
      );
      items.push(...(body.items ?? []));
      timeZone ??= body.timeZone ?? null;
      pageToken = body.nextPageToken;
      if (!pageToken) return { items, nextSyncToken: body.nextSyncToken ?? null, timeZone };
    }
    throw new GoogleCalendarApiError('events: too many pages', 500, undefined);
  }

  async #token(forceRefresh: boolean): Promise<string> {
    try {
      const token = await this.#getAccessToken({ forceRefresh });
      if (!token) throw new Error('no access token');
      return token;
    } catch (error) {
      if (error instanceof GoogleCalendarApiError) throw error;
      throw new GoogleCalendarAuthError('Could not get a Google access token', 401, undefined, {
        cause: error,
      });
    }
  }

  async #get<S extends z.ZodType>(
    path: string,
    query: URLSearchParams,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = `${this.#baseUrl}${path}?${query}`;
    let res = await this.#send(url, await this.#token(false));
    if (res.status === 401) {
      await res.body?.cancel();
      res = await this.#send(url, await this.#token(true));
    }
    if (!res.ok) throw await this.#error(res, path);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new GoogleCalendarApiError(`${path}: unexpected response shape`, res.status, undefined);
    }
    return parsed.data;
  }

  #send(url: string, token: string): Promise<Response> {
    this.requestCount++;
    return this.#fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async #error(res: Response, path: string): Promise<GoogleCalendarApiError> {
    let reason: string | undefined;
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const body = GoogleErrorSchema.safeParse(await res.json());
      if (body.success) {
        reason = body.data.error.errors?.[0]?.reason;
        if (body.data.error.message) message = body.data.error.message;
      }
    } catch {
      // not JSON
    }
    const text = `Google Calendar ${path}: ${message}`;
    if (res.status === 410) return new GoogleSyncTokenExpiredError(text, 410, reason);
    if (res.status === 401) return new GoogleCalendarAuthError(text, 401, reason);
    // Token lacks the scope → reconnect. Other 403s (`forbidden` on one shared calendar, rate limits) are
    // per request, not the account's.
    if (res.status === 403 && reason === 'insufficientPermissions') {
      return new GoogleCalendarAuthError(text, 403, reason);
    }
    return new GoogleCalendarApiError(text, res.status, reason);
  }
}
