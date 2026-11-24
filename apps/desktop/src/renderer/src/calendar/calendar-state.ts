/**
 * Renderer side of calendar notes + detection (7.3): the "Upcoming" snapshot and the "Start notes?" prompt,
 * pushed by main (`calendar:changed`, `prompt:changed`). Subscribes before asking, like `main-state.ts`; the
 * calendar snapshot keeps the higher `seq`.
 */
import type { CalendarSnapshot, MeetingPrompt, UpcomingEvent } from '@oat/core/bridge';
import { useEffect, useState } from 'react';

import { bridge, call } from '../bridge.ts';

export function useCalendar(enabled: boolean): CalendarSnapshot | null {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const apply = (next: CalendarSnapshot) => {
      if (!cancelled) setSnapshot((cur) => (cur && cur.seq >= next.seq ? cur : next));
    };
    const unsubscribe = bridge().subscribe('calendar:changed', apply);
    void call('calendar:get')
      .then(apply)
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);
  return snapshot;
}

export function useMeetingPrompt(enabled: boolean): MeetingPrompt | null {
  const [prompt, setPrompt] = useState<MeetingPrompt | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let pushed = false;
    const unsubscribe = bridge().subscribe('prompt:changed', ({ prompt: next }) => {
      pushed = true;
      setPrompt(next);
    });
    void call('prompt:get')
      .then((current) => {
        if (!pushed) setPrompt(current);
      })
      .catch(() => {});
    return unsubscribe;
  }, [enabled]);
  return prompt;
}

export interface DayGroup {
  label: string;
  /** Midnight (local) of the day the group stands for. */
  date: Date;
  events: UpcomingEvent[];
}

/** "Today" / "Tomorrow" groups (local dates), in time order; anything later goes under its weekday. */
export function groupByDay(events: readonly UpcomingEvent[], now: Date): DayGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const groups = new Map<string, DayGroup>();
  for (const event of events) {
    const start = new Date(event.start);
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    // In progress since yesterday still belongs to today's list.
    const offset = Math.max(0, Math.round((day.getTime() - today.getTime()) / 86_400_000));
    const label =
      offset === 0
        ? 'Today'
        : offset === 1
          ? 'Tomorrow'
          : day.toLocaleDateString('en-US', { weekday: 'long' });
    const group = groups.get(label) ?? {
      label,
      date: new Date(today.getTime() + offset * 86_400_000),
      events: [],
    };
    group.events.push(event);
    groups.set(label, group);
  }
  return [...groups.values()];
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** "3:00 PM". */
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** "3:00 – 3:30 PM" (same meridiem shortened). */
export function formatRange(startIso: string, endIso: string): string {
  const start = TIME.format(new Date(startIso));
  const end = TIME.format(new Date(endIso));
  const sm = start.slice(-2);
  const em = end.slice(-2);
  return sm === em && /[AP]M$/.test(sm) ? `${start.slice(0, -3)} – ${end}` : `${start} – ${end}`;
}

export const CONFERENCE_LABELS = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  teams: 'Teams',
} as const;
