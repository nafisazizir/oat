import { ROLES, type Role } from '@oat/core';

/** Workspace roles as shown in the UI, with one line on what each can do. */
export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including deleting the workspace.' },
  admin: { label: 'Admin', description: 'Manages settings, members and invites.' },
  member: { label: 'Member', description: 'Creates and edits notes.' },
  viewer: { label: 'Viewer', description: 'Reads shared notes.' },
};

/** Highest role first (the order of role pickers; `@oat/core` lists them that way). */
export const ROLES_DESC: readonly Role[] = ROLES;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Emoji offered in the workspace icon picker. Any single emoji is accepted. */
export const ICON_CHOICES = [
  '🌾',
  '🥣',
  '🍞',
  '🌱',
  '🌻',
  '🍀',
  '🌊',
  '🔥',
  '⭐',
  '🚀',
  '💡',
  '🎯',
  '📚',
  '🧪',
  '🛠️',
  '🎨',
  '🎧',
  '📈',
  '🧭',
  '🏔️',
  '🐝',
  '🦊',
  '🐙',
  '🍊',
] as const;

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Normalises a workspace icon: exactly one emoji (one grapheme, so ZWJ sequences, skin tones and flags
 * count as one), else `null` for "no icon". Throws for anything else (text, several emoji).
 */
export function parseWorkspaceIcon(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(trimmed)];
  if (graphemes.length !== 1 || trimmed.length > 16 || !PICTOGRAPHIC.test(trimmed)) {
    throw new Error('Pick a single emoji.');
  }
  return trimmed;
}

/** The safe icon to render for a stored `logo` (older or foreign values fall back to the initial). */
export function workspaceIcon(logo: string | null | undefined): string | null {
  try {
    return parseWorkspaceIcon(logo);
  } catch {
    return null;
  }
}

/** "in 6 days", "in 3 hours", "today" — how long an invite stays valid. */
export function expiresIn(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'in less than an hour';
  if (hours < 24) return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}
