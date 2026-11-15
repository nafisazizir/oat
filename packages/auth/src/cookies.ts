/**
 * Edge-safe session-cookie presence check for request proxies (no DB, no validation): use it only for
 * optimistic redirects; the real check is `auth.api.getSession`.
 */
export { getSessionCookie } from 'better-auth/cookies';
