/**
 * Desktop sign-in (task 1.8; protocol in `@oat/auth/desktop-link`), main process only.
 *
 * - `beginSignIn`: fresh `state` + PKCE verifier (memory only, 10 minutes, one at a time), browser opens
 *   `${web}/desktop/sign-in?state&challenge`.
 * - `handleDeepLink`: `oat://auth?code&state`. Unless `state` matches the pending sign-in, the link is
 *   ignored (a link we didn't ask for must neither sign us in nor cancel a real attempt). A match uses
 *   the pending sign-in up, then exchanges `code` + verifier for a bearer token.
 * - The token lives in this object and in `TokenStore` (safeStorage). Only the user reaches `MainStore`.
 */
import {
  desktopSignInUrl,
  parseDesktopDeepLink,
  pkceChallenge,
  randomDesktopValue,
  timingSafeEqualStrings,
} from '@oat/auth/desktop-link';
import type { DesktopUser } from '@oat/core/bridge';

import { type ApiClient, ApiError, type MeResult } from './api-client.ts';
import { BridgeError, type Logger } from './ipc.ts';
import type { SttGrant } from './stt-credentials.ts';
import type { MainStore } from './store.ts';
import type { TokenStore } from './token-store.ts';

/** How long the app waits for the browser to come back. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

const MESSAGES = {
  failed: 'Sign-in didn’t complete. Try again.',
  expired: 'Your session ended. Sign in again.',
  timedOut: 'Sign-in timed out. Try again.',
  browser: 'Couldn’t open your browser.',
} as const;

interface PendingSignIn {
  state: string;
  verifier: string;
  expiresAt: number;
}

export interface AuthControllerOptions {
  webUrl: string;
  api: ApiClient;
  tokens: TokenStore;
  store: MainStore;
  openExternal: (url: string) => Promise<void>;
  log: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export class AuthController {
  #token: string | null = null;
  #pending: PendingSignIn | null = null;
  #cancelTimer: (() => void) | null = null;
  readonly #o: Required<AuthControllerOptions>;

  constructor(options: AuthControllerOptions) {
    this.#o = {
      now: Date.now,
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      },
      ...options,
    };
  }

  get signedIn(): boolean {
    return this.#token !== null;
  }

  /** Launch: trust the stored session right away (fast, works offline), then re-check it with the API. */
  async restore(): Promise<void> {
    const stored = await this.#o.tokens.load();
    if (!stored) {
      this.#setSignedOut(null);
      return;
    }
    this.#token = stored.token;
    this.#setSignedIn(stored.user);
    void this.me().catch(() => {
      /* `me` already signs out on 401; network errors keep the session */
    });
  }

  async beginSignIn(): Promise<{ opened: boolean }> {
    const state = randomDesktopValue();
    const verifier = randomDesktopValue();
    this.#pending = { state, verifier, expiresAt: this.#o.now() + SIGN_IN_TIMEOUT_MS };
    this.#cancelTimer?.();
    this.#cancelTimer = this.#o.setTimer(() => {
      if (this.#pending?.state !== state) return;
      this.#pending = null;
      this.#setSignedOut(MESSAGES.timedOut);
    }, SIGN_IN_TIMEOUT_MS);
    this.#o.store.update((s) => ({ ...s, auth: { status: 'signing-in' } }));
    const url = desktopSignInUrl(this.#o.webUrl, state, await pkceChallenge(verifier));
    try {
      await this.#o.openExternal(url);
      return { opened: true };
    } catch (error) {
      this.#o.log.error('auth: could not open the browser', error);
      this.#clearPending();
      this.#setSignedOut(MESSAGES.browser);
      return { opened: false };
    }
  }

  cancelSignIn(): void {
    if (!this.#pending) return;
    this.#clearPending();
    this.#setSignedOut(null);
  }

  /** Handles an `oat://` link. Resolves `true` when it signed the app in. */
  async handleDeepLink(raw: string): Promise<boolean> {
    const link = parseDesktopDeepLink(raw);
    if (!link) {
      this.#o.log.warn('auth: ignored a malformed deep link');
      return false;
    }
    const pending = this.#pending;
    if (!pending || pending.expiresAt <= this.#o.now()) {
      this.#o.log.warn('auth: ignored a sign-in link nobody asked for');
      return false;
    }
    if (!timingSafeEqualStrings(link.state, pending.state)) {
      this.#o.log.warn('auth: ignored a sign-in link with the wrong state');
      return false;
    }
    this.#clearPending(); // single use, whatever happens next
    try {
      const { token, user } = await this.#o.api.exchangeDesktopCode(link.code, pending.verifier);
      const previous = this.#token;
      this.#token = token;
      // Signing in again replaces the session: revoke the old one on the server (best effort).
      if (previous && previous !== token) {
        void this.#o.api.signOut(previous).catch((error: unknown) => {
          this.#o.log.warn(`auth: could not revoke the previous session (${String(error)})`);
        });
      }
      await this.#o.tokens.save({ token, user }).catch((error: unknown) => {
        this.#o.log.error('auth: could not store the session', error);
      });
      this.#setSignedIn(user);
      this.#o.log.info('auth: signed in');
      return true;
    } catch (error) {
      this.#o.log.error('auth: code exchange failed', error);
      this.#setSignedOut(MESSAGES.failed);
      return false;
    }
  }

  /** Revokes the session on the server (best effort; offline still signs out locally). */
  async signOut(): Promise<void> {
    const token = this.#token;
    this.#token = null;
    this.#clearPending();
    if (token) {
      await this.#o.api.signOut(token).catch((error: unknown) => {
        this.#o.log.warn(`auth: server sign-out failed (${String(error)}); signed out locally`);
      });
    }
    await this.#o.tokens.clear();
    this.#setSignedOut(null);
  }

  /** `api:me`: the account behind the token. A rejected token signs the app out. */
  async me(): Promise<MeResult> {
    const token = this.#token;
    if (!token) throw new BridgeError('unauthorized', 'Not signed in.');
    try {
      const result = await this.#o.api.me(token);
      if (this.#token === token) this.#setSignedIn(result.user);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.unauthorized) {
        if (this.#token === token) {
          this.#token = null;
          await this.#o.tokens.clear();
          this.#setSignedOut(MESSAGES.expired);
        }
        throw new BridgeError('unauthorized', MESSAGES.expired);
      }
      if (error instanceof ApiError) throw new BridgeError('unavailable', error.message);
      throw error;
    }
  }

  /**
   * A short-lived STT token for the signed-in user (2.5). Throws when signed out; a rejected session
   * signs the app out, as in `me()`. Failures are plain errors: the STT stream reports and retries them.
   */
  async sttGrant(): Promise<SttGrant> {
    const token = this.#token;
    if (!token) throw new Error('not signed in');
    try {
      return await this.#o.api.sttToken(token);
    } catch (error) {
      if (error instanceof ApiError && error.unauthorized && this.#token === token) {
        this.#token = null;
        await this.#o.tokens.clear();
        this.#setSignedOut(MESSAGES.expired);
      }
      throw error;
    }
  }

  /**
   * Runs an API call with the session token (sync, 2.6). Signed out → `ApiError(401)`; a session the
   * server rejects signs the app out, as in `me()`. The token never leaves the main process.
   */
  async withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = this.#token;
    if (!token) throw new ApiError(401, 'Not signed in.');
    try {
      return await fn(token);
    } catch (error) {
      if (error instanceof ApiError && error.unauthorized && this.#token === token) {
        this.#token = null;
        await this.#o.tokens.clear();
        this.#setSignedOut(MESSAGES.expired);
      }
      throw error;
    }
  }

  #clearPending() {
    this.#pending = null;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #setSignedIn(user: DesktopUser) {
    this.#o.store.update((s) => {
      const a = s.auth;
      if (
        a.status === 'signed-in' &&
        a.user.id === user.id &&
        a.user.email === user.email &&
        a.user.name === user.name
      ) {
        return s;
      }
      return { ...s, auth: { status: 'signed-in', user } };
    });
  }

  #setSignedOut(error: string | null) {
    this.#o.store.update((s) => ({ ...s, auth: { status: 'signed-out', error } }));
  }
}
