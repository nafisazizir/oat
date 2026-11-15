/**
 * Pure helpers for the desktop's local search box and conflicted-copy list (3.5), unit-tested.
 */

/** Match markers in a local search snippet (`@oat/local-store` `HIGHLIGHT_START` / `HIGHLIGHT_END`). */
const START = '\u0001';
const END = '\u0002';

/** A snippet split into plain and highlighted parts (React renders them as text: no HTML involved). */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const s = rest.indexOf(START);
    if (s < 0) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (s > 0) parts.push({ text: rest.slice(0, s), hit: false });
    const e = rest.indexOf(END, s + 1);
    const hit = e < 0 ? rest.slice(s + 1) : rest.slice(s + 1, e);
    if (hit) parts.push({ text: hit, hit: true });
    rest = e < 0 ? '' : rest.slice(e + 1);
  }
  return parts.map((p) => ({ ...p, text: p.text.split(START).join('').split(END).join('') }));
}

/** `m:ss` (or `h:mm:ss`) of a transcript position. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "Conflicted copy from Studio Mac · Nov 14, 3:04 PM" (the time in the viewer's locale). */
export function conflictOrigin(device: string | null, at: string | null): string {
  const when = at
    ? new Date(at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  return `Conflicted copy from ${[device ?? 'another device', when].filter(Boolean).join(' · ')}`;
}
