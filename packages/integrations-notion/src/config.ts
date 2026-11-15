/**
 * Where Notion lives (D-11) and which OAuth client to use. Env only, no code changes:
 *
 * 1. `NOTION_BASE_URL` if set (origin + optional prefix before `/v1`).
 * 2. A real OAuth client (`NOTION_OAUTH_CLIENT_ID`) → `https://api.notion.com`.
 * 3. Otherwise the mocks service: `${MOCKS_URL}/notion` (`http://localhost:14010/notion` by default).
 *
 * With `NODE_ENV=production` and none of these, Notion is not configured (`null`): the integration is hidden
 * instead of pointing at localhost. The mock accepts any client id/secret, so blank credentials default to
 * `oat-dev`/`oat-dev-secret` there; real Notion requires both.
 */
export const NOTION_API_URL = 'https://api.notion.com';
export const DEFAULT_MOCK_NOTION_URL = 'http://localhost:14010/notion';

export interface NotionConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** `real` = api.notion.com. */
  mode: 'real' | 'mock';
}

const trimmed = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t.replace(/\/+$/, '') : undefined;
};

export function isRealNotion(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.notion.com';
  } catch {
    return false;
  }
}

export function resolveNotionConfig(
  env: Record<string, string | undefined> = process.env,
): NotionConfig | null {
  const clientId = trimmed(env.NOTION_OAUTH_CLIENT_ID);
  const clientSecret = trimmed(env.NOTION_OAUTH_CLIENT_SECRET);
  const mocks = trimmed(env.MOCKS_URL);
  const baseUrl =
    trimmed(env.NOTION_BASE_URL) ??
    (clientId
      ? NOTION_API_URL
      : mocks
        ? `${mocks}/notion`
        : env.NODE_ENV === 'production'
          ? undefined
          : DEFAULT_MOCK_NOTION_URL);
  if (!baseUrl) return null;
  const real = isRealNotion(baseUrl);
  if (real && (!clientId || !clientSecret)) return null;
  return {
    baseUrl,
    clientId: clientId ?? 'oat-dev',
    clientSecret: clientSecret ?? 'oat-dev-secret',
    mode: real ? 'real' : 'mock',
  };
}
