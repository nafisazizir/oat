import { desktopCallbackUrl, pkceChallenge, randomDesktopValue } from '@oat/auth/desktop-link';
import type { DesktopUser } from '@oat/core/bridge';
import type { SyncPushRequest } from '@oat/core/sync';
import { describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError } from './api-client.ts';
import { AuthController, SIGN_IN_TIMEOUT_MS } from './auth.ts';
import type { Logger } from './ipc.ts';
import { MainStore } from './store.ts';
import type { StoredSession, TokenStore } from './token-store.ts';

const WEB = 'http://localhost:3000';
const ADA: DesktopUser = { id: 'u1', email: 'ada@oat.test', name: 'Ada' };

/** A stand-in for apps/web: issues codes bound to a PKCE challenge and redeems them once. */
function fakeWeb() {
  const codes = new Map<string, { challenge: string; user: DesktopUser }>();
  const sessions = new Set<string>();
  let n = 0;
  const api = {
    exchangeDesktopCode: vi.fn(async (code: string, verifier: string) => {
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.challenge !== (await pkceChallenge(verifier))) {
        throw new ApiError(400, 'refused');
      }
      const token = `session${++n}.signature`;
      sessions.add(token);
      return { token, user: entry.user };
    }),
    me: vi.fn(async (token: string) => {
      if (!sessions.has(token)) throw new ApiError(401, 'ended');
      return { user: ADA, activeWorkspaceId: 'w1' };
    }),
    sttToken: vi.fn(async (token: string) => {
      if (!sessions.has(token)) throw new ApiError(401, 'ended');
      return { accessToken: `stt-${token}`, expiresIn: 60, listenUrl: 'ws://localhost:1/listen' };
    }),
    syncPush: vi.fn(async (token: string, _body: SyncPushRequest) => {
      if (!sessions.has(token)) throw new ApiError(401, 'ended');
      return { results: [] };
    }),
    syncPull: vi.fn(async (token: string, _cursor: string | null) => {
      if (!sessions.has(token)) throw new ApiError(401, 'ended');
      return { changes: [], cursor: null, hasMore: false, workspaceIds: [] };
    }),
    syncBackfill: vi.fn(async () => ({ changes: [], next: null })),
    openSyncEvents: vi.fn(async () => new Response('')),
    calendarUpcoming: vi.fn(async () => ({ connected: false, state: null, events: [] })),
    signOut: vi.fn(async (token: string) => void sessions.delete(token)),
  } satisfies ApiClient;
  return {
    api,
    sessions,
    /** What the web page does for a signed-in user: a code for the browser URL the app opened. */
    issue(browserUrl: string, user = ADA) {
      const url = new URL(browserUrl);
      const code = randomDesktopValue();
      codes.set(code, { challenge: url.searchParams.get('challenge')!, user });
      return desktopCallbackUrl(code, url.searchParams.get('state')!);
    },
  };
}

function memoryTokens(initial: StoredSession | null = null) {
  let saved = initial;
  return {
    get saved() {
      return saved;
    },
    save: vi.fn(async (s: StoredSession) => ((saved = s), true)),
    load: vi.fn(async () => saved),
    clear: vi.fn(async () => void (saved = null)),
  };
}

function setup({
  stored = null as StoredSession | null,
  now = (() => 1_000) as () => number,
} = {}) {
  const web = fakeWeb();
  const tokens = memoryTokens(stored);
  const store = new MainStore();
  const opened: string[] = [];
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const timers: { fn: () => void; ms: number }[] = [];
  const auth = new AuthController({
    webUrl: WEB,
    api: web.api,
    tokens: tokens as unknown as TokenStore,
    store,
    log,
    openExternal: async (url) => void opened.push(url),
    now,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  return { auth, web, tokens, store, opened, log, timers };
}

describe('sign-in', () => {
  it('opens the browser at the web page with a fresh state and an S256 challenge', async () => {
    const { auth, opened, store } = setup();
    expect(await auth.beginSignIn()).toEqual({ opened: true });
    const url = new URL(opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(`${WEB}/desktop/sign-in`);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('challenge')).toMatch(/^[\w-]{43}$/);
    expect(store.state.auth).toEqual({ status: 'signing-in' });
    // No verifier in the URL: only its hash.
    await auth.beginSignIn();
    expect(opened[1]).not.toBe(opened[0]);
  });

  it('a matching deep link exchanges the code, stores the token and signs in', async () => {
    const { auth, web, opened, tokens, store } = setup();
    await auth.beginSignIn();
    expect(await auth.handleDeepLink(web.issue(opened[0]!))).toBe(true);
    expect(store.state.auth).toEqual({ status: 'signed-in', user: ADA });
    expect(tokens.saved).toEqual({ token: 'session1.signature', user: ADA });
    expect(JSON.stringify(store.snapshot())).not.toContain('session1');
    expect(auth.signedIn).toBe(true);
  });

  it('ignores a link when no sign-in is pending (login CSRF)', async () => {
    const { auth, web, store } = setup();
    await auth.restore();
    const forged = web.issue(`${WEB}/desktop/sign-in?state=${randomDesktopValue()}&challenge=x`);
    expect(await auth.handleDeepLink(forged)).toBe(false);
    expect(web.api.exchangeDesktopCode).not.toHaveBeenCalled();
    expect(store.state.auth.status).toBe('signed-out');
  });

  it('ignores a link with another state and keeps waiting for the real one', async () => {
    const { auth, web, opened, store } = setup();
    await auth.beginSignIn();
    const real = web.issue(opened[0]!);
    const forged = desktopCallbackUrl(randomDesktopValue(), randomDesktopValue());
    expect(await auth.handleDeepLink(forged)).toBe(false);
    expect(store.state.auth.status).toBe('signing-in');
    expect(await auth.handleDeepLink(real)).toBe(true);
  });

  it('uses a pending sign-in once: a replayed link does nothing', async () => {
    const { auth, web, opened } = setup();
    await auth.beginSignIn();
    const link = web.issue(opened[0]!);
    expect(await auth.handleDeepLink(link)).toBe(true);
    expect(await auth.handleDeepLink(link)).toBe(false);
    expect(web.api.exchangeDesktopCode).toHaveBeenCalledTimes(1);
  });

  it('a code issued for another PKCE challenge is refused by the server', async () => {
    const { auth, web, opened, store } = setup();
    await auth.beginSignIn();
    // An attacker's code (their own challenge) delivered with our state: the exchange fails.
    const state = new URL(opened[0]!).searchParams.get('state')!;
    const attacker = web.issue(
      `${WEB}/desktop/sign-in?state=${state}&challenge=${randomDesktopValue()}`,
    );
    expect(await auth.handleDeepLink(attacker)).toBe(false);
    expect(store.state.auth).toEqual({
      status: 'signed-out',
      error: 'Sign-in didn’t complete. Try again.',
    });
  });

  it('ignores malformed links', async () => {
    const { auth, web } = setup();
    await auth.beginSignIn();
    for (const raw of ['oat://evil?code=x', 'https://x', 'oat://auth?code=a&state=b']) {
      expect(await auth.handleDeepLink(raw)).toBe(false);
    }
    expect(web.api.exchangeDesktopCode).not.toHaveBeenCalled();
  });

  it('expires a pending sign-in', async () => {
    let now = 1_000;
    const { auth, web, opened, store, timers } = setup({ now: () => now });
    await auth.beginSignIn();
    const link = web.issue(opened[0]!);
    now += SIGN_IN_TIMEOUT_MS;
    expect(await auth.handleDeepLink(link)).toBe(false);
    timers[0]!.fn();
    expect(store.state.auth).toEqual({
      status: 'signed-out',
      error: 'Sign-in timed out. Try again.',
    });
  });

  it('cancel forgets the pending sign-in', async () => {
    const { auth, web, opened, store } = setup();
    await auth.beginSignIn();
    const link = web.issue(opened[0]!);
    auth.cancelSignIn();
    expect(store.state.auth).toEqual({ status: 'signed-out', error: null });
    expect(await auth.handleDeepLink(link)).toBe(false);
  });

  it('reports a browser that would not open', async () => {
    const { auth, store, log } = setup();
    const failing = new AuthController({
      webUrl: WEB,
      api: fakeWeb().api,
      tokens: memoryTokens() as unknown as TokenStore,
      store,
      log,
      openExternal: async () => {
        throw new Error('no browser');
      },
    });
    void auth;
    expect(await failing.beginSignIn()).toEqual({ opened: false });
    expect(store.state.auth).toEqual({
      status: 'signed-out',
      error: 'Couldn’t open your browser.',
    });
  });
});

describe('session lifecycle', () => {
  it('signing in again revokes the previous server session', async () => {
    const { auth, web, opened, tokens } = setup();
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[0]!));
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[1]!));
    await vi.waitFor(() => expect(web.api.signOut).toHaveBeenCalledWith('session1.signature'));
    expect([...web.sessions]).toEqual(['session2.signature']);
    expect(tokens.saved?.token).toBe('session2.signature');
  });

  it('restores a stored session immediately, then checks it', async () => {
    const { auth, web, store } = setup({ stored: { token: 'session9.sig', user: ADA } });
    web.sessions.add('session9.sig');
    await auth.restore();
    expect(store.state.auth).toEqual({ status: 'signed-in', user: ADA });
    await vi.waitFor(() => expect(web.api.me).toHaveBeenCalledWith('session9.sig'));
  });

  it('a revoked stored token signs out with a message', async () => {
    const { auth, store, tokens } = setup({ stored: { token: 'gone.sig', user: ADA } });
    await auth.restore();
    await vi.waitFor(() =>
      expect(store.state.auth).toEqual({
        status: 'signed-out',
        error: 'Your session ended. Sign in again.',
      }),
    );
    expect(tokens.saved).toBeNull();
  });

  it('api:me needs a token and returns the account', async () => {
    const { auth, web, opened } = setup();
    await auth.restore();
    await expect(auth.me()).rejects.toMatchObject({ code: 'unauthorized' });
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[0]!));
    expect(await auth.me()).toEqual({ user: ADA, activeWorkspaceId: 'w1' });
  });

  it('network trouble keeps the session and reports unavailable', async () => {
    const { auth, web, store } = setup({ stored: { token: 't.s', user: ADA } });
    web.api.me.mockRejectedValue(new ApiError(0, 'offline'));
    await auth.restore();
    await expect(auth.me()).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.state.auth.status).toBe('signed-in');
  });

  it('sign-out revokes on the server and forgets the token', async () => {
    const { auth, web, opened, tokens, store } = setup();
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[0]!));
    await auth.signOut();
    expect(web.api.signOut).toHaveBeenCalledWith('session1.signature');
    expect(web.sessions.size).toBe(0);
    expect(tokens.saved).toBeNull();
    expect(store.state.auth).toEqual({ status: 'signed-out', error: null });
    expect(auth.signedIn).toBe(false);
  });

  it('sign-out still signs out locally when the server is unreachable', async () => {
    const { auth, web, tokens, store } = setup({ stored: { token: 't.s', user: ADA } });
    web.api.signOut.mockRejectedValue(new ApiError(0, 'offline'));
    web.api.me.mockRejectedValue(new ApiError(0, 'offline'));
    await auth.restore();
    await auth.signOut();
    expect(tokens.saved).toBeNull();
    expect(store.state.auth.status).toBe('signed-out');
  });
});

describe('STT grant (2.5)', () => {
  it('needs a session and passes the bearer token to the API (never to the caller)', async () => {
    const { auth, web, opened } = setup();
    await auth.restore();
    await expect(auth.sttGrant()).rejects.toThrow(/not signed in/);
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[0]!));
    const grant = await auth.sttGrant();
    expect(web.api.sttToken).toHaveBeenCalledWith('session1.signature');
    expect(grant).toEqual({
      accessToken: 'stt-session1.signature',
      expiresIn: 60,
      listenUrl: 'ws://localhost:1/listen',
    });
  });

  it('a revoked session signs the app out', async () => {
    const { auth, store, tokens, web } = setup({ stored: { token: 'gone.s', user: ADA } });
    web.api.me.mockRejectedValue(new ApiError(0, 'offline'));
    await auth.restore();
    await expect(auth.sttGrant()).rejects.toBeInstanceOf(ApiError);
    expect(store.state.auth).toEqual({
      status: 'signed-out',
      error: 'Your session ended. Sign in again.',
    });
    expect(tokens.saved).toBeNull();
  });

  it('an unavailable API keeps the session', async () => {
    const { auth, web, store } = setup({ stored: { token: 't.s', user: ADA } });
    web.api.me.mockRejectedValue(new ApiError(0, 'offline'));
    web.api.sttToken.mockRejectedValue(new ApiError(503, 'down'));
    await auth.restore();
    await expect(auth.sttGrant()).rejects.toMatchObject({ status: 503 });
    expect(store.state.auth.status).toBe('signed-in');
  });
});

describe('withSession (sync, 2.6)', () => {
  it('passes the token to the call; signed out is a 401', async () => {
    const { auth, web, opened } = setup();
    await auth.restore();
    await expect(auth.withSession(async () => 1)).rejects.toMatchObject({ status: 401 });
    await auth.beginSignIn();
    await auth.handleDeepLink(web.issue(opened[0]!));
    expect(await auth.withSession((t) => web.api.syncPull(t, null))).toMatchObject({
      hasMore: false,
    });
    expect(web.api.syncPull).toHaveBeenCalledWith('session1.signature', null);
  });

  it('a 401 from the call signs out; other failures keep the session', async () => {
    const { auth, store, web } = setup({ stored: { token: 't.s', user: ADA } });
    web.api.me.mockRejectedValue(new ApiError(0, 'offline'));
    await auth.restore();
    await expect(
      auth.withSession(() => Promise.reject(new ApiError(503, 'down'))),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.state.auth.status).toBe('signed-in');
    await expect(
      auth.withSession((t) => web.api.syncPush(t, { entries: [] })),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(store.state.auth.status).toBe('signed-out');
  });
});
