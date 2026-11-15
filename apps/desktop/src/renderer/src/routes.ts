import type { WindowKind } from '@oat/core/bridge';

/** `#/widget` → `widget`; anything else is the main window (one renderer bundle, route per window). */
export function windowKindFromHash(hash: string): WindowKind {
  const route = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return route === 'widget' ? 'widget' : 'main';
}
