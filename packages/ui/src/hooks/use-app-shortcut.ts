'use client';

import { useEffect } from 'react';

export type AppShortcut = 'palette' | 'sidebar' | 'assistant';
const KEYS: Record<AppShortcut, string> = { palette: 'k', sidebar: 'b', assistant: 'j' };

export function matchesAppShortcut(event: KeyboardEvent, shortcut: AppShortcut): boolean {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.shiftKey ||
    event.altKey ||
    !(event.metaKey || event.ctrlKey) ||
    event.key.toLowerCase() !== KEYS[shortcut]
  )
    return false;
  const target = event.target instanceof Element ? event.target : null;
  if (shortcut === 'palette' && target?.closest('.oat-editor')) return false;
  if (
    shortcut === 'sidebar' &&
    target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')
  )
    return false;
  return true;
}

export function useAppShortcut(shortcut: AppShortcut, action: (() => void) | undefined) {
  useEffect(() => {
    if (!action) return;
    const onKey = (event: KeyboardEvent) => {
      if (!matchesAppShortcut(event, shortcut)) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, action]);
}
