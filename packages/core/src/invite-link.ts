export const INVITE_TOKEN = /^[A-Za-z0-9_-]{32}$(?![\s\S])/;

export function desktopInviteUrl(token: string): string | null {
  return INVITE_TOKEN.test(token) ? `oat://invite/${token}` : null;
}

export function parseInviteLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length !== 45) return null;
  const match = /^oat:\/\/invite\/([A-Za-z0-9_-]{32})$/.exec(raw);
  return match?.[1] ?? null;
}
