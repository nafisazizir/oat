export function groupNotesByDate<T>(
  notes: readonly T[],
  dateOf: (note: T) => string | null,
  now: number,
  timeZone?: string,
): { label: string; notes: T[] }[] {
  const zone = timeZone ? { timeZone } : {};
  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...zone,
  });
  const day = (date: Date) => {
    const p = Object.fromEntries(parts.formatToParts(date).map((p) => [p.type, p.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  };
  const today = day(new Date(now));
  const groups = new Map<number, { label: string; notes: T[] }>();
  const stamp = (note: T) => Date.parse(dateOf(note) ?? '');
  for (const note of [...notes].sort((a, b) => (stamp(b) || 0) - (stamp(a) || 0))) {
    const date = new Date(stamp(note));
    const key = Number.isFinite(date.getTime()) ? day(date) : -Infinity;
    let group = groups.get(key);
    if (!group) {
      const label =
        key === today
          ? 'Today'
          : key === today - 86_400_000
            ? 'Yesterday'
            : key === -Infinity
              ? 'Earlier'
              : new Intl.DateTimeFormat('en', {
                  month: 'short',
                  day: 'numeric',
                  ...(new Date(key).getUTCFullYear() !== new Date(today).getUTCFullYear()
                    ? ({ year: 'numeric' } as const)
                    : {}),
                  ...zone,
                }).format(date);
      group = { label, notes: [] };
      groups.set(key, group);
    }
    group.notes.push(note);
  }
  return [...groups.values()];
}
